import type {
    Block,
    Capture,
    CaptureMeta,
    InvalidReason,
    MacroResult,
    Rect,
    ScrapeJob,
    Screenshot,
} from "@watchthatsite/types";
import type { Logger } from "pino";
import type { BrowserContext, Page, Response } from "playwright-core";
import {
    captureDeadlineMs,
    macroCaptureDeadlineMs,
    navigationTimeoutMs,
} from "../config/constants.js";
import type { CaptureDeps } from "../types.js";
import { enableBlocking } from "./blocking.js";
import { extractBlocks, pageSize } from "./blocks.js";
import type { BrowserPoolContextLease } from "./browser-pool.js";
import { contentTypeFor, screenshotKey } from "./keys.js";
import {
    captureStable,
    encodeShot,
    isBlankCapture,
    type Clip,
    type Frame,
} from "./screenshot.js";
import { NetworkTracker, stabilize } from "./stabilize.js";
import { checkResponse } from "./validity.js";

/** One page load, stabilized and read, before anything is uploaded. */
type Observation = {
    invalid: InvalidReason | null;
    /** Set with `macro_failed`: what a person needs to know to fix the Macro. */
    error: string | null;
    blocks: Block[];
    truncated: boolean;
    frame: Frame | null;
    masks: Rect[];
    stable: boolean;
    /** Whether the network went quiet before its cap, on the last load. */
    networkQuiet: boolean;
    httpStatus: number;
    finalUrl: string;
    title: string;
    loadMs: number;
    settleMs: number;
    macro: MacroResult | null;
};

/**
 * Takes the Capture for one Run: open the URL, stabilize, replay the Macro
 * if the job names one, stabilize again, then read the blocks and take the
 * screenshot from the page as it now is, check validity, and upload the
 * screenshot and storage state.
 *
 * Returns an `ok` or `invalid` Capture. Anything that stops the Capture from
 * being taken at all (navigation failure, upload failure) is thrown; the
 * handler turns it into an `error` Capture.
 */
export async function takeCapture(
    deps: CaptureDeps,
    job: ScrapeJob,
): Promise<Capture> {
    const start = Date.now();
    const log = deps.logger.child({
        monitorId: job.monitor_id,
        runId: job.run_id,
    });

    const lease = await leaseContext(deps, job, log);
    // Past the deadline the context is closed, which fails whatever is still
    // waiting on it; the signal also stops a repair between model turns.
    const abort = new AbortController();
    const work = capturePage(
        deps,
        job,
        lease.context,
        start,
        log,
        abort.signal,
    );

    // Every step has its own bound, but a hung page (or a browser starved
    // of CPU) must never hold a job forever.
    const deadlineMs =
        job.macro_id === null ? captureDeadlineMs : macroCaptureDeadlineMs;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new Error(
                        `Capture did not finish within ${Math.round(deadlineMs / 1000)} s`,
                    ),
                ),
            deadlineMs,
        );
    });
    try {
        return await Promise.race([work, deadline]);
    } catch (err) {
        abort.abort();
        await lease.context.close().catch(() => undefined);
        work.catch(() => undefined);
        throw err;
    } finally {
        clearTimeout(timer);
        await lease.release();
    }
}

/**
 * Leases a context. With a storage state key, the Monitor's cookies and
 * localStorage from its last valid Run are restored, which keeps the session
 * a Macro signed in to, and pins A/B variants and cookie-consent choices. A
 * missing or unreadable state starts fresh.
 */
async function leaseContext(
    deps: CaptureDeps,
    job: ScrapeJob,
    log: Logger,
): Promise<BrowserPoolContextLease> {
    const viewport = { width: job.viewport.w, height: job.viewport.h };
    const key = job.storage_state_key;
    if (key === null) return deps.pool.acquire();

    if (deps.objectStore === null) {
        log.warn(
            "[capture] storage state requested but storage is not configured",
        );
        return deps.pool.acquire();
    }

    let storageState: Awaited<
        ReturnType<BrowserContext["storageState"]>
    > | null = null;
    try {
        const bytes = await deps.objectStore.getObject(key);
        if (bytes !== null) {
            storageState = JSON.parse(new TextDecoder().decode(bytes));
        }
    } catch (err) {
        log.warn({ err, key }, "[capture] could not restore storage state");
    }

    if (storageState === null) return deps.pool.acquire();
    return deps.pool.acquireWith({ storageState, viewport });
}

/** Saves the context's storage state after a valid Capture. Best effort. */
async function saveStorageState(
    deps: CaptureDeps,
    job: ScrapeJob,
    context: BrowserContext,
    log: Logger,
): Promise<void> {
    const key = job.storage_state_key;
    if (key === null || deps.objectStore === null) return;
    try {
        const state = await context.storageState();
        await deps.objectStore.putObject(
            key,
            new TextEncoder().encode(JSON.stringify(state)),
            { contentType: "application/json" },
        );
    } catch (err) {
        log.warn({ err, key }, "[capture] could not save storage state");
    }
}

export function navigationUrl(url: string): string {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(
            `Invalid URL scheme: ${u.protocol}. Only http and https are allowed.`,
        );
    }
    const proxyUrl = process.env.PROXY_URL;
    if (!proxyUrl) return url;
    const scheme = u.protocol.replace(":", "");
    const proxyBase = proxyUrl.replace(/\/$/, "");
    return `${proxyBase}/api/v1/preview/proxy/${scheme}/${u.host}${u.pathname}${u.search}`;
}

async function capturePage(
    deps: CaptureDeps,
    job: ScrapeJob,
    context: BrowserContext,
    start: number,
    log: Logger,
    signal: AbortSignal,
): Promise<Capture> {
    const page = await context.newPage();
    try {
        await page.setViewportSize({
            width: job.viewport.w,
            height: job.viewport.h,
        });
        page.setDefaultNavigationTimeout(navigationTimeoutMs);
        page.setDefaultTimeout(navigationTimeoutMs);
        await enableBlocking(
            page,
            await deps.blockers.forJob(job.capture),
            log,
        );

        const obs = await observe(deps, page, job, log, signal);
        if (obs.invalid !== null) {
            return buildCapture(job, "invalid", obs, null, start);
        }

        const encoded = await encodeShot(
            obs.frame!,
            job.capture.screenshot,
            log,
        );
        const screenshot = await upload(
            deps,
            screenshotKey(job.monitor_id, job.run_id, encoded.format),
            encoded.bytes,
            encoded.format,
            obs.frame!,
        );

        await saveStorageState(deps, job, context, log);

        return buildCapture(job, "ok", obs, screenshot, start);
    } finally {
        await page.close().catch(() => undefined);
    }
}

async function upload(
    deps: CaptureDeps,
    key: string,
    bytes: Buffer,
    format: Screenshot["format"],
    frame: Frame,
): Promise<Screenshot> {
    if (deps.objectStore === null) {
        throw new Error("Screenshot storage is not configured");
    }
    await deps.objectStore.putObject(key, bytes, {
        contentType: contentTypeFor(format),
    });
    return { key, w: frame.w, h: frame.h, format };
}

/**
 * Remembers the last document the main frame loaded. After a Macro has
 * clicked through a sign-in or opened another page, the status and headers
 * that say whether the Capture is valid are those of the page now shown,
 * not of the first response.
 */
function trackMainDocument(page: Page, first: Response): () => Response {
    let last = first;
    const onResponse = (response: Response) => {
        const request = response.request();
        if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame() &&
            // A redirect hop is not what ends up on screen.
            (response.status() < 300 || response.status() >= 400)
        ) {
            last = response;
        }
    };
    page.on("response", onResponse);
    return () => {
        page.off("response", onResponse);
        return last;
    };
}

/** Opens the URL, replays the Macro, stabilizes and reads one Capture's worth of the page. */
async function observe(
    deps: CaptureDeps,
    page: Page,
    job: ScrapeJob,
    log: Logger,
    signal: AbortSignal,
): Promise<Observation> {
    const t0 = Date.now();
    const target = navigationUrl(job.url);
    const tracker = new NetworkTracker(page);
    try {
        const response = await page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
        });
        if (!response) throw new Error("No navigation response received");
        const lastDocument = trackMainDocument(page, response);
        await page
            .waitForLoadState("load", { timeout: navigationTimeoutMs })
            .catch(() => undefined);
        const loadMs = Date.now() - t0;

        const t1 = Date.now();
        const stabilizeOptions = {
            extraWaitMs: job.capture.extra_wait_ms,
            maxHeight: job.capture.max_height,
            scroll: true,
        };
        let networkQuiet = (await stabilize(page, tracker, stabilizeOptions))
            .networkQuiet;

        let macro: MacroResult | null = null;
        let macroError: string | null = null;
        if (job.macro_id !== null) {
            if (deps.macros === null) {
                throw new Error(
                    "This Run has a Macro, but Macro replay is not configured on the worker (it needs Postgres)",
                );
            }
            const run = await deps.macros.run({
                page,
                tracker,
                job,
                log,
                signal,
            });
            macro = run.result;
            macroError = run.error;
            if (macro.status !== "failed") {
                // The Macro left the page somewhere new: let it finish
                // loading and trigger its lazy content like the first load.
                networkQuiet = (
                    await stabilize(page, tracker, stabilizeOptions)
                ).networkQuiet;
            }
        }

        const shown = lastDocument();
        const headers = await shown.allHeaders().catch(() => ({}));
        const page_ = await page.evaluate(() => ({
            title: document.title,
            bodyText:
                document.body ? document.body.innerText.slice(0, 5000) : "",
            html: document.documentElement.outerHTML.slice(0, 200_000),
        }));

        const base: Observation = {
            invalid: null,
            error: null,
            blocks: [],
            truncated: false,
            frame: null,
            masks: [],
            stable: true,
            networkQuiet,
            httpStatus: shown.status(),
            finalUrl: page.url(),
            title: page_.title,
            loadMs,
            settleMs: Date.now() - t1,
            macro,
        };

        if (macro?.status === "failed") {
            return { ...base, invalid: "macro_failed", error: macroError };
        }

        const invalid = checkResponse(
            {
                status: base.httpStatus,
                requestedUrl: target,
                finalUrl: base.finalUrl,
                title: page_.title,
                bodyText: page_.bodyText,
                html: page_.html,
                headers,
            },
            // A Macro may legitimately end on another host.
            { allowCrossDomain: macro !== null },
        );
        if (invalid) return { ...base, invalid };

        const extracted = await extractBlocks(page);
        const withBlocks = { ...base, ...extracted };
        // A page with pictures and no words is as empty as a page with
        // nothing: there is no text to compare, and usually it did not load.
        if (extracted.blocks.every(b => b.text === "")) {
            return { ...withBlocks, invalid: "empty" };
        }

        const shot = await captureStable(
            page,
            clipFor(job, await pageSize(page)),
        );
        const observed: Observation = {
            ...withBlocks,
            settleMs: Date.now() - t1,
            frame: shot.frame,
            masks: shot.unstable,
            stable: shot.stable,
        };
        const blockArea = blockAreaIn(extracted.blocks, shot.frame);
        if (isBlankCapture(shot.frame.png, blockArea)) {
            return { ...observed, invalid: "blank_screenshot" };
        }
        return observed;
    } finally {
        tracker.detach();
    }
}

/**
 * The screenshot area: the whole page (or just the first viewport when
 * `full_page` is off) at the viewport's width, capped at `max_height`.
 */
function clipFor(job: ScrapeJob, size: { w: number; h: number }): Clip {
    const pageH =
        job.capture.full_page ? size.h : Math.min(size.h, job.viewport.h);
    return {
        x: 0,
        y: 0,
        width: job.viewport.w,
        height: Math.max(1, Math.min(pageH, job.capture.max_height)),
    };
}

/**
 * Total area of the text blocks inside the frame, for the blank check. Blocks
 * kept only for their look are left out: a large background would make a
 * sparse but healthy page look as if most of it failed to paint.
 */
function blockAreaIn(blocks: Block[], frame: Frame): number {
    let area = 0;
    for (const b of blocks) {
        if (b.text === "") continue;
        const [x, y, w, h] = b.rect;
        const cw = Math.min(x + w, frame.w) - Math.max(x, 0);
        const ch = Math.min(y + h, frame.h) - Math.max(y, 0);
        if (cw > 0 && ch > 0) area += cw * ch;
    }
    return area;
}

function buildCapture(
    job: ScrapeJob,
    status: "ok" | "invalid",
    obs: Observation,
    screenshot: Screenshot | null,
    start: number,
): Capture {
    const meta: CaptureMeta = {
        http_status: obs.httpStatus,
        final_url: obs.finalUrl,
        title: obs.title,
        stable: obs.stable,
        network_quiet: obs.networkQuiet,
        env_version: job.env_version,
        timings_ms: {
            load: obs.loadMs,
            settle: obs.settleMs,
            total: Date.now() - start,
        },
    };
    return {
        version: 3,
        run_id: job.run_id,
        monitor_id: job.monitor_id,
        status,
        invalid_reason: status === "invalid" ? obs.invalid : null,
        error: obs.error ? { message: obs.error } : null,
        blocks: obs.blocks,
        truncated: obs.truncated,
        screenshot,
        masks: status === "ok" ? obs.masks : [],
        meta,
        macro: obs.macro,
    };
}

/**
 * The Capture published when one could not be taken at all. Every field is
 * still present, so the scheduler's strict decoder accepts it.
 */
export function errorCapture(
    job: Pick<ScrapeJob, "run_id" | "monitor_id" | "env_version">,
    message: string,
    totalMs = 0,
): Capture {
    return {
        version: 3,
        run_id: job.run_id,
        monitor_id: job.monitor_id,
        status: "error",
        invalid_reason: null,
        error: { message: message || "Unknown error" },
        blocks: [],
        truncated: false,
        screenshot: null,
        masks: [],
        meta: {
            http_status: 0,
            final_url: "",
            title: "",
            stable: false,
            network_quiet: false,
            env_version: job.env_version,
            timings_ms: { load: 0, settle: 0, total: totalMs },
        },
        macro: null,
    };
}
