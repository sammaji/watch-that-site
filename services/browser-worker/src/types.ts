import type { Capture } from "@watchthatsite/types";
import type { Logger } from "pino";
import type { BlockerProvider } from "./lib/blocking.js";
import type { BrowserPool } from "./lib/browser-pool.js";
import type { MacroRunner } from "./macro/run.js";

// Worker-internal types. The messages and HTTP bodies this service exchanges
// (ScrapeJob, Capture, the agent API) live in `@watchthatsite/types`.

export type PutObjectOptions = {
    contentType?: string;
};

/**
 * The slice of the object-store Worker client this service uses. Kept local so
 * the worker does not depend on the client's full surface; index.ts adapts
 * `@watchthatsite/cloudflare/client` to it.
 */
export interface ObjectStore {
    putObject(
        key: string,
        body: Uint8Array,
        options?: PutObjectOptions,
    ): Promise<unknown>;
    /** The object's bytes, or null when it does not exist. */
    getObject(key: string): Promise<Uint8Array | null>;
}

export type CaptureDeps = {
    logger: Logger;
    pool: BrowserPool;
    /** Null when storage is not configured; screenshots then fail the Capture. */
    objectStore: ObjectStore | null;
    blockers: BlockerProvider;
    /**
     * Replays a job's Macro (and repairs it). Null when the worker runs
     * without Postgres; a job that names a Macro then fails.
     */
    macros: MacroRunner | null;
};

export type HandlerDeps = CaptureDeps & {
    publishResult: (result: Capture) => Promise<void>;
};
