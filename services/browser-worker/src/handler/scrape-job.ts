import { type CaptureOptions, type ScrapeJob } from "@watchthatsite/types";
import { errorCapture, takeCapture } from "../lib/capture.js";
import { storageStateKey } from "../lib/keys.js";
import type { HandlerDeps } from "../types.js";

export interface Handler {
    execute(job: ScrapeJob): Promise<void>;
    validate(message: string): ScrapeJob;
    reportFailure(job: ScrapeJob, error: unknown): Promise<void>;
}

export const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upper bound on the Monitor's extra wait. */
const maxExtraWaitMs = 60_000;
/** Upper bound on the screenshot height cap. */
const maxMaxHeight = 20_000;
const maxViewport = 4096;

/** The error's message, without Playwright's multi-line call log. */
function errorMessage(error: unknown): string {
    const message =
        error instanceof Error ? error.message
        : typeof error === "string" ? error
        : "Unknown error";
    return message.split("\n")[0]!.trim() || "Unknown error";
}

function fail(reason: string): never {
    throw new Error(`Invalid job format: ${reason}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function bool(v: unknown, field: string): boolean {
    if (typeof v !== "boolean") fail(`${field} must be a boolean`);
    return v;
}

function parseCapture(v: unknown): CaptureOptions {
    if (!isObject(v)) fail("capture must be an object");
    if (v.screenshot !== "webp" && v.screenshot !== "png") {
        fail(`unknown capture.screenshot ${JSON.stringify(v.screenshot)}`);
    }
    if (!isInt(v.max_height, 1, maxMaxHeight)) {
        fail(`capture.max_height must be an integer in 1..${maxMaxHeight}`);
    }
    if (!isInt(v.extra_wait_ms, 0, maxExtraWaitMs)) {
        fail(
            `capture.extra_wait_ms must be an integer in 0..${maxExtraWaitMs}`,
        );
    }
    return {
        screenshot: v.screenshot,
        full_page: bool(v.full_page, "capture.full_page"),
        max_height: v.max_height,
        extra_wait_ms: v.extra_wait_ms,
        block_ads: bool(v.block_ads, "capture.block_ads"),
        block_cookie_banners: bool(
            v.block_cookie_banners,
            "capture.block_cookie_banners",
        ),
    };
}

/**
 * Parses and checks a ScrapeJob v3. Every field is required and typed; a job
 * that fails is rejected without a Capture and dead-lettered by the consumer.
 */
export function parseScrapeJob(body: string): ScrapeJob {
    const parsed = JSON.parse(body) as unknown;
    if (!isObject(parsed)) fail("expected one job object");
    const p = parsed;

    if (p.version !== 3)
        fail(`unsupported version ${JSON.stringify(p.version)}`);
    // Object keys embed both ids, and the object store rejects any key whose
    // segments are not UUIDs.
    if (typeof p.run_id !== "string" || !UUID.test(p.run_id)) {
        fail("run_id must be a UUID");
    }
    if (typeof p.monitor_id !== "string" || !UUID.test(p.monitor_id)) {
        fail("monitor_id must be a UUID");
    }
    if (typeof p.url !== "string") fail("url must be a string");
    let url: URL;
    try {
        url = new URL(p.url);
    } catch {
        fail("url is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        fail("url must be http or https");
    }

    if (!isObject(p.viewport)) fail("viewport must be an object");
    const { w, h } = p.viewport;
    if (!isInt(w, 1, maxViewport) || !isInt(h, 1, maxViewport)) {
        fail(`viewport.w and viewport.h must be integers in 1..${maxViewport}`);
    }

    const capture = parseCapture(p.capture);

    const macroId = p.macro_id;
    if (
        macroId !== null &&
        (typeof macroId !== "string" || !UUID.test(macroId))
    ) {
        fail("macro_id must be a UUID or null");
    }

    const stateKey = p.storage_state_key;
    if (stateKey !== null) {
        if (typeof stateKey !== "string") {
            fail("storage_state_key must be a string or null");
        }
        // A job may only read and write its own Monitor's state.
        if (stateKey !== storageStateKey(p.monitor_id)) {
            fail(`storage_state_key must be ${storageStateKey(p.monitor_id)}`);
        }
    }

    if (typeof p.env_version !== "string" || p.env_version === "") {
        fail("env_version must be a non-empty string");
    }

    return {
        version: 3,
        run_id: p.run_id,
        monitor_id: p.monitor_id,
        url: p.url,
        viewport: { w, h },
        capture,
        macro_id: macroId,
        storage_state_key: stateKey,
        env_version: p.env_version,
    };
}

export function createScrapeJobHandler(deps: HandlerDeps): Handler {
    const { logger, publishResult } = deps;

    return {
        /**
         * Takes the Capture and publishes exactly one Capture v3 for the job:
         * `ok`, `invalid` with its reason, or `error` when the Capture could
         * not be taken. Only a failure to publish is thrown.
         */
        async execute(job: ScrapeJob): Promise<void> {
            const log = logger.child({
                monitorId: job.monitor_id,
                runId: job.run_id,
            });
            const start = Date.now();

            let capture;
            try {
                capture = await takeCapture(deps, job);
            } catch (err) {
                log.warn({ err }, "capture failed");
                capture = errorCapture(
                    job,
                    errorMessage(err),
                    Date.now() - start,
                );
            }

            await publishResult(capture);

            log.info(
                {
                    status: capture.status,
                    invalidReason: capture.invalid_reason,
                    error: capture.error?.message,
                    blocks: capture.blocks.length,
                    truncated: capture.truncated,
                    stable: capture.meta.stable,
                    macro: capture.macro?.status ?? null,
                    timings: capture.meta.timings_ms,
                },
                "monitor captured",
            );
        },

        validate: parseScrapeJob,

        async reportFailure(job: ScrapeJob, error: unknown): Promise<void> {
            await publishResult(errorCapture(job, errorMessage(error)));
        },
    };
}
