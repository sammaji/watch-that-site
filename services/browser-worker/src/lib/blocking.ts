import {
    adsAndTrackingLists,
    fullLists,
    PlaywrightBlocker,
} from "@ghostery/adblocker-playwright";
import type { CaptureOptions } from "@watchthatsite/types";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Page } from "playwright-core";

/**
 * Ad, tracker and cookie-banner blocking.
 *
 * Two engines exist: `ads` (EasyList, EasyPrivacy, uBlock filters) and
 * `cookies` (EasyList Cookie and the uBlock annoyances lists). A job turns
 * them on with `block_ads` and `block_cookie_banners`. Each engine is built
 * once per process and serialized to disk under BLOCKER_CACHE_DIR, so a
 * restart does not download the lists again.
 *
 * Blocking is best effort. When the lists cannot be downloaded (no network,
 * GitHub rate limit) the Capture goes ahead without it and a warning is
 * logged; the failed build is retried after `retryAfterMs`.
 */

export type BlockerKind = "ads" | "cookies";

/** Builds the engine for one kind. Injectable so tests never hit the network. */
export type BlockerLoader = (kind: BlockerKind) => Promise<PlaywrightBlocker>;

export interface BlockerProvider {
    /** The engines the job asks for; unavailable ones are left out. */
    forJob(capture: CaptureOptions): Promise<PlaywrightBlocker[]>;
}

const cookieLists = fullLists.filter(url => !adsAndTrackingLists.includes(url));

export function defaultCacheDir(): string {
    return process.env.BLOCKER_CACHE_DIR || join(tmpdir(), "wts-adblocker");
}

/** Downloads (or reads from the disk cache) the lists for one kind. */
export function listLoader(cacheDir: string): BlockerLoader {
    return async kind => {
        await mkdir(cacheDir, { recursive: true });
        const caching = {
            path: join(cacheDir, `engine-${kind}.bin`),
            read: async (path: string) => new Uint8Array(await readFile(path)),
            write: (path: string, buffer: Uint8Array) =>
                writeFile(path, buffer),
        };
        return kind === "ads" ?
                PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch, caching)
            :   PlaywrightBlocker.fromLists(fetch, cookieLists, {}, caching);
    };
}

export function createBlockerProvider(opts: {
    logger: Logger;
    load?: BlockerLoader;
    retryAfterMs?: number;
}): BlockerProvider {
    const load = opts.load ?? listLoader(defaultCacheDir());
    const retryAfterMs = opts.retryAfterMs ?? 10 * 60_000;
    const engines = new Map<BlockerKind, Promise<PlaywrightBlocker | null>>();

    function get(kind: BlockerKind): Promise<PlaywrightBlocker | null> {
        let engine = engines.get(kind);
        if (!engine) {
            engine = load(kind).catch((err: unknown) => {
                opts.logger.warn(
                    { err, kind },
                    "[blocking] could not load block lists; capturing without them",
                );
                // Forget the failure after a while so a transient outage
                // does not disable blocking for the life of the process.
                setTimeout(() => engines.delete(kind), retryAfterMs).unref();
                return null;
            });
            engines.set(kind, engine);
        }
        return engine;
    }

    return {
        async forJob(capture) {
            const kinds: BlockerKind[] = [];
            if (capture.block_ads) kinds.push("ads");
            if (capture.block_cookie_banners) kinds.push("cookies");
            const loaded = await Promise.all(kinds.map(get));
            return loaded.filter((b): b is PlaywrightBlocker => b !== null);
        },
    };
}

/** Enables the given engines on a page before it navigates. */
export async function enableBlocking(
    page: Page,
    blockers: PlaywrightBlocker[],
    logger: Logger,
): Promise<void> {
    for (const blocker of blockers) {
        try {
            // The blocker is typed against `playwright`; playwright-core's
            // Page is the same class.
            await blocker.enableBlockingInPage(page as never);
        } catch (err) {
            logger.warn({ err }, "[blocking] could not enable blocking");
        }
    }
}
