import type { Page, Request } from "playwright-core";

/**
 * Page stabilization before Capture: wait for the page to finish
 * loading, trigger lazy content, and freeze motion, so two Captures of an
 * unchanged page produce the same blocks and pixels.
 */

/** No request in flight for this long counts as "network quiet". */
export const quietWindowMs = 500;
/** Overall cap on one wait for network quiet. */
export const quietCapMs = 10_000;
/** Quiet window and cap of the light settle between Macro steps. */
const settleQuietMs = 300;
const settleCapMs = 5_000;
/** Cap on waiting for `document.fonts.ready`. */
const fontsCapMs = 5_000;
/** Pause after each scroll step, so lazy loaders can fire their requests. */
const scrollStepPauseMs = 100;

/**
 * CSS that freezes motion. `animations: "disabled"` on the screenshot only
 * covers the moment of the shot; this keeps the page still while blocks are
 * read and between the frames of the two-frame check.
 */
export const freezeCss = `*, *::before, *::after {
  transition: none !important;
  animation: none !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}`;

/**
 * Counts in-flight requests on a page. Attach it before navigating, so the
 * main document and its first subresources are counted.
 */
export class NetworkTracker {
    private readonly inflight = new Set<Request>();
    private lastChange = Date.now();

    constructor(private readonly page: Page) {
        page.on("request", this.onStart);
        page.on("requestfinished", this.onEnd);
        page.on("requestfailed", this.onEnd);
    }

    private readonly onStart = (req: Request) => {
        this.inflight.add(req);
        this.lastChange = Date.now();
    };

    private readonly onEnd = (req: Request) => {
        if (this.inflight.delete(req)) this.lastChange = Date.now();
    };

    get pending(): number {
        return this.inflight.size;
    }

    /**
     * Resolves once no request has been in flight for `quietMs`, or after
     * `capMs`. Returns whether quiet was reached. Long-polling and streaming
     * pages never go quiet; the cap bounds them.
     */
    async waitForQuiet(
        quietMs = quietWindowMs,
        capMs = quietCapMs,
    ): Promise<boolean> {
        const deadline = Date.now() + capMs;
        // A request started in this window restarts the clock.
        this.lastChange = Math.max(this.lastChange, Date.now() - quietMs);
        for (;;) {
            const now = Date.now();
            if (this.inflight.size === 0 && now - this.lastChange >= quietMs) {
                return true;
            }
            if (now >= deadline) return false;
            await sleep(Math.min(50, deadline - now));
        }
    }

    detach(): void {
        this.page.off("request", this.onStart);
        this.page.off("requestfinished", this.onEnd);
        this.page.off("requestfailed", this.onEnd);
    }
}

export type StabilizeOptions = {
    extraWaitMs: number;
    /** Lazy-load scrolling stops here (the screenshot's height cap). */
    maxHeight: number;
    /** Scroll through the page to trigger lazy loading. */
    scroll: boolean;
};

export type StabilizeResult = {
    /** Whether the network went quiet before the cap, both times. */
    networkQuiet: boolean;
};

/**
 * Runs after navigation has reached `domcontentloaded`:
 * 1. `load` (bounded), then `document.fonts.ready` (bounded);
 * 2. 500 ms of network quiet (capped at 10 s), then the Monitor's extra wait;
 * 3. scroll to the bottom in viewport steps (up to `maxHeight`) to trigger
 *    lazy loading, wait for quiet again, scroll back to the top;
 * 4. inject the motion-freezing CSS.
 */
export async function stabilize(
    page: Page,
    tracker: NetworkTracker,
    opts: StabilizeOptions,
): Promise<StabilizeResult> {
    await page
        .waitForLoadState("load", { timeout: quietCapMs })
        .catch(() => undefined);

    await page
        .evaluate(
            cap =>
                Promise.race([
                    document.fonts.ready.then(() => undefined),
                    new Promise<void>(resolve => setTimeout(resolve, cap)),
                ]),
            fontsCapMs,
        )
        .catch(() => undefined);

    let networkQuiet = await tracker.waitForQuiet();

    if (opts.extraWaitMs > 0) {
        await sleep(opts.extraWaitMs);
    }

    if (opts.scroll) {
        await scrollThrough(page, opts.maxHeight);
        networkQuiet = (await tracker.waitForQuiet()) && networkQuiet;
        await page.evaluate(() => window.scrollTo(0, 0));
    }

    await page.addStyleTag({ content: freezeCss }).catch(() => undefined);
    // Let the style take effect and any scroll-triggered layout settle.
    await page
        .evaluate(
            () =>
                new Promise<void>(resolve => {
                    // Frames can stop being produced (a throttled or
                    // occluded page), so a timer bounds the wait.
                    setTimeout(resolve, 500);
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    );
                }),
        )
        .catch(() => undefined);

    return { networkQuiet };
}

async function scrollThrough(page: Page, maxHeight: number): Promise<void> {
    await page.evaluate(
        async ({ maxHeight, pause }) => {
            const step = Math.max(window.innerHeight, 1);
            // The page may grow as lazy content arrives, so re-read its height
            // on every step.
            for (let y = step; ; y += step) {
                const bottom = Math.min(
                    document.documentElement.scrollHeight,
                    maxHeight,
                );
                if (y >= bottom) {
                    window.scrollTo(0, bottom);
                    break;
                }
                window.scrollTo(0, y);
                await new Promise(resolve => setTimeout(resolve, pause));
            }
            await new Promise(resolve => setTimeout(resolve, pause));
        },
        { maxHeight, pause: scrollStepPauseMs },
    );
}

/**
 * The light settle used between Macro steps and agent actions: enough for a
 * click's navigation or XHR to land, without the lazy-load scroll and motion
 * freeze of a full stabilize (those run once more before the Capture).
 */
export async function settle(
    page: Page,
    tracker: NetworkTracker,
    capMs = settleCapMs,
): Promise<void> {
    // A click that navigates has not started its request yet when click()
    // returns; give it a beat so the quiet check sees it.
    await sleep(80);
    await page
        .waitForLoadState("domcontentloaded", { timeout: capMs })
        .catch(() => undefined);
    await tracker.waitForQuiet(settleQuietMs, capMs);
    await page
        .evaluate(
            () =>
                new Promise<void>(resolve => {
                    setTimeout(resolve, 300);
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    );
                }),
        )
        .catch(() => undefined);
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
