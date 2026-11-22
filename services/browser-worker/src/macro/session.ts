import type { Logger } from "pino";
import type { Page } from "playwright-core";
import { navigationTimeoutMs } from "../config/constants.js";
import type { BlockerProvider } from "../lib/blocking.js";
import { enableBlocking } from "../lib/blocking.js";
import type { BrowserPool } from "../lib/browser-pool.js";
import { NetworkTracker, stabilize } from "../lib/stabilize.js";
import type { MonitorRow } from "../store/store.js";

/** Screenshot height cap the scheduler asks Captures for; lazy-load scrolling stops there. */
const scrollMaxHeight = 8000;

export type MonitorPage = {
    page: Page;
    tracker: NetworkTracker;
    close(): Promise<void>;
};

/**
 * Opens a Monitor's URL in a fresh context (no saved session) and stabilizes
 * it the way a Capture does, so what is recorded or tested here behaves the
 * same in a Run. Used to record a Macro, to prove a recording replays, and
 * to test steps the owner edited.
 */
export async function openMonitorPage(
    deps: { pool: BrowserPool; blockers: BlockerProvider; logger: Logger },
    monitor: Pick<
        MonitorRow,
        "url" | "viewportW" | "viewportH" | "blockAds" | "extraWaitMs"
    >,
): Promise<MonitorPage> {
    const url = new URL(monitor.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("The Monitor's URL must be http or https");
    }
    const lease = await deps.pool.acquireWith({
        viewport: { width: monitor.viewportW, height: monitor.viewportH },
    });
    let tracker: NetworkTracker | null = null;
    try {
        const page = await lease.context.newPage();
        page.setDefaultNavigationTimeout(navigationTimeoutMs);
        page.setDefaultTimeout(navigationTimeoutMs);
        await enableBlocking(
            page,
            await deps.blockers.forJob({
                screenshot: "webp",
                full_page: true,
                max_height: scrollMaxHeight,
                extra_wait_ms: monitor.extraWaitMs,
                block_ads: monitor.blockAds,
                block_cookie_banners: true,
            }),
            deps.logger,
        );
        tracker = new NetworkTracker(page);
        await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
        });
        await stabilize(page, tracker, {
            extraWaitMs: monitor.extraWaitMs,
            maxHeight: scrollMaxHeight,
            scroll: true,
        });
        const live = tracker;
        return {
            page,
            tracker: live,
            close: async () => {
                live.detach();
                await lease.context.close().catch(() => undefined);
                await lease.release();
            },
        };
    } catch (err) {
        tracker?.detach();
        await lease.context.close().catch(() => undefined);
        await lease.release();
        throw err;
    }
}
