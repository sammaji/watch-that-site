/**
 * Test harness: a real headless Chromium pool, a local fixture HTTP server, an
 * in-memory object store and job builders. Tests never touch the internet.
 */
import type { ScrapeJob } from "@watchthatsite/types";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import type { BlockerProvider } from "../lib/blocking.js";
import { BrowserPool } from "../lib/browser-pool.js";
import type { CaptureDeps, ObjectStore } from "../types.js";

export const MONITOR_ID = "8dea949d-d40b-49f6-8f9a-9e31f891eb4e";
export const RUN_ID = "2136440b-8e77-4a2d-8fe2-fcaea8af11f7";

export const silentLogger = pino({ level: "silent" });

export type Route = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
) => void;

export type FixtureServer = {
    /** e.g. `http://127.0.0.1:54321` */
    origin: string;
    port: number;
    close(): Promise<void>;
};

/** Serves `routes` by exact path; anything else is a 404 with text. */
export async function startServer(
    routes: Record<string, Route>,
): Promise<FixtureServer> {
    const server = http.createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const route = routes[path];
        if (route) {
            route(req, res);
            return;
        }
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html><body><h1>Not found</h1></body></html>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        port,
        close: () =>
            new Promise<void>(resolve => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export function html(body: string, head = "", status = 200): Route {
    return (_req, res) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(
            `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
        );
    };
}

export class MemoryStore implements ObjectStore {
    readonly objects = new Map<
        string,
        { body: Uint8Array; contentType?: string }
    >();

    async putObject(
        key: string,
        body: Uint8Array,
        options?: { contentType?: string },
    ): Promise<unknown> {
        this.objects.set(key, {
            body: new Uint8Array(body),
            ...(options?.contentType ?
                { contentType: options.contentType }
            :   {}),
        });
        return { key };
    }

    async getObject(key: string): Promise<Uint8Array | null> {
        return this.objects.get(key)?.body ?? null;
    }
}

export const noBlockers: BlockerProvider = { forJob: async () => [] };

export async function launchPool(contexts = 2): Promise<BrowserPool> {
    const pool = new BrowserPool({
        maxInstances: 1,
        maxContextsPerBrowser: contexts,
    });
    await pool.launch();
    return pool;
}

export function deps(
    pool: BrowserPool,
    store: ObjectStore | null = new MemoryStore(),
    overrides: Partial<CaptureDeps> = {},
): CaptureDeps {
    return {
        logger: silentLogger,
        pool,
        objectStore: store,
        blockers: noBlockers,
        macros: null,
        ...overrides,
    };
}

type JobOverrides = Omit<Partial<ScrapeJob>, "capture"> & {
    capture?: Partial<ScrapeJob["capture"]>;
};

export function makeJob(url: string, overrides: JobOverrides = {}): ScrapeJob {
    const { capture, ...rest } = overrides;
    return {
        version: 3,
        run_id: RUN_ID,
        monitor_id: MONITOR_ID,
        url,
        viewport: { w: 800, h: 600 },
        macro_id: null,
        storage_state_key: null,
        env_version: "2026-11-21.1",
        ...rest,
        capture: {
            screenshot: "png",
            full_page: true,
            max_height: 8000,
            extra_wait_ms: 0,
            block_ads: false,
            block_cookie_banners: false,
            ...capture,
        },
    };
}
