/**
 * Local notification sinks for the diffing E2E suite (plan §3.0.2).
 *
 * One HTTP server records everything the notification service and the
 * scheduler's AI judge send, so tests can assert on sink traffic without any
 * third-party service:
 *
 * - `POST /slack/:id`, `/discord/:id`, `/webhook/:id`: chat and webhook
 *   Channels point their URL here.
 * - `POST /email`: the notifications service in `EMAIL_TRANSPORT=capture`
 *   mode posts the would-be email here.
 * - `POST /ai` or `/ai/v1/chat/completions`: an OpenAI chat-completions stub
 *   for the AI judge (`AI_JUDGE_URL`), scripted per test via `POST /_script`.
 *
 * Control routes:
 * - `GET /_requests?path=<prefix>` lists recorded requests (oldest first).
 * - `DELETE /_requests` clears them (and the AI scripts).
 * - `POST /_script {match, response}` adds an AI script; `DELETE /_script`
 *   clears them. The first script whose `match` is a substring of the request
 *   body wins. `response` is a verdict object, `"timeout"` (hold the request
 *   for 30 s) or `"invalid"` (reply with content that is not JSON).
 * - `GET /_health` returns `{ok: true}`.
 *
 * Use `startSinks()`/`stopSinks()` in-process, or run it standalone:
 * `pnpm sinks` (or `tsx tests/lib/sinks.ts`).
 */
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export const DEFAULT_SINK_PORT = 8799;
export const AI_TIMEOUT_HOLD_MS = 30_000;

export type SinkRequest = {
    /** Monotonic sequence number within this server's lifetime. */
    seq: number;
    method: string;
    /** Path without the query string, e.g. `/slack/abc`. */
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    /** Raw body text. */
    body: string;
    /** Parsed JSON body, or null when the body is not JSON. */
    json: unknown;
    received_at: string;
};

export type AIVerdict = {
    important: boolean;
    score?: number;
    category?: string;
    summary?: string;
    evidence?: string[];
};

export type AIScriptResponse = AIVerdict | Record<string, unknown> | "timeout" | "invalid";

export type AIScript = {
    /** Substring of the request body; "" matches everything. */
    match: string;
    response: AIScriptResponse;
};

export const DEFAULT_AI_VERDICT: AIVerdict = {
    important: true,
    score: 80,
    category: "other",
    summary: "",
    evidence: [],
};

const RECORDED_PREFIXES = ["/slack/", "/discord/", "/webhook/"];
const AI_PATHS = new Set(["/ai", "/ai/v1/chat/completions", "/ai/chat/completions"]);

export class SinkServer {
    private readonly server: Server;
    private readonly requests: SinkRequest[] = [];
    private scripts: AIScript[] = [];
    private seq = 0;
    private readonly held = new Set<ServerResponse>();
    private readonly holdTimers = new Set<NodeJS.Timeout>();

    constructor() {
        this.server = createServer((req, res) => {
            void this.handle(req, res).catch(error => {
                if (!res.headersSent) {
                    sendJSON(res, 500, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            });
        });
    }

    get port() {
        const address = this.server.address() as AddressInfo | null;
        return address?.port ?? 0;
    }

    get url() {
        return `http://127.0.0.1:${this.port}`;
    }

    async start(port = DEFAULT_SINK_PORT, host = "0.0.0.0") {
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(port, host, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        return this;
    }

    async stop() {
        for (const timer of this.holdTimers) clearTimeout(timer);
        this.holdTimers.clear();
        for (const res of this.held) res.destroy();
        this.held.clear();
        this.server.closeAllConnections?.();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    /** list returns recorded requests whose path starts with prefix. */
    list(prefix = "") {
        return this.requests.filter(r => r.path.startsWith(prefix));
    }

    clear() {
        this.requests.length = 0;
        this.scripts = [];
    }

    addScript(script: AIScript) {
        this.scripts.push(script);
    }

    private async handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? "/", "http://sinks.local");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = (req.method ?? "GET").toUpperCase();

        if (path === "/_health") {
            return sendJSON(res, 200, { ok: true, recorded: this.requests.length });
        }

        if (path === "/_requests") {
            if (method === "GET") {
                const prefix = url.searchParams.get("path") ?? "";
                return sendJSON(res, 200, { requests: this.list(prefix) });
            }
            if (method === "DELETE") {
                this.clear();
                return sendJSON(res, 200, { ok: true });
            }
            return sendJSON(res, 405, { error: "use GET or DELETE" });
        }

        if (path === "/_script") {
            if (method === "DELETE") {
                this.scripts = [];
                return sendJSON(res, 200, { ok: true });
            }
            if (method === "GET") {
                return sendJSON(res, 200, { scripts: this.scripts });
            }
            if (method !== "POST") return sendJSON(res, 405, { error: "use POST" });
            const body = await readBody(req);
            const parsed = parseJSON(body) as Partial<AIScript> | null;
            if (!parsed || !("response" in parsed)) {
                return sendJSON(res, 400, { error: "body must be {match, response}" });
            }
            const response = parsed.response as AIScriptResponse;
            if (
                typeof response === "string" &&
                response !== "timeout" &&
                response !== "invalid"
            ) {
                return sendJSON(res, 400, {
                    error: 'response must be an object, "timeout" or "invalid"',
                });
            }
            this.addScript({ match: String(parsed.match ?? ""), response });
            return sendJSON(res, 200, { ok: true, scripts: this.scripts.length });
        }

        const body = await readBody(req);
        const isAI = AI_PATHS.has(path);
        const isEmail = path === "/email";
        const isRecorded = RECORDED_PREFIXES.some(p => path.startsWith(p) && path.length > p.length);

        if (!isAI && !isEmail && !isRecorded) {
            return sendJSON(res, 404, { error: `no sink at ${path}` });
        }
        if (method !== "POST") {
            return sendJSON(res, 405, { error: "sinks accept POST only" });
        }

        this.requests.push({
            seq: ++this.seq,
            method,
            path,
            query: Object.fromEntries(url.searchParams),
            headers: flattenHeaders(req),
            body,
            json: parseJSON(body),
            received_at: new Date().toISOString(),
        });

        if (isAI) return this.respondAI(body, res);

        // Slack answers a successful incoming webhook with plain "ok".
        if (path.startsWith("/slack/")) {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
            return;
        }
        // Discord answers 204 unless ?wait=true.
        if (path.startsWith("/discord/")) {
            res.writeHead(204);
            res.end();
            return;
        }
        return sendJSON(res, 200, { ok: true });
    }

    private respondAI(body: string, res: ServerResponse) {
        const script = this.scripts.find(s => body.includes(s.match));
        const response = script ? script.response : DEFAULT_AI_VERDICT;

        if (response === "timeout") {
            this.held.add(res);
            const timer = setTimeout(() => {
                this.holdTimers.delete(timer);
                this.held.delete(res);
                if (!res.writableEnded && !res.destroyed) {
                    sendJSON(res, 504, { error: "stub timeout" });
                }
            }, AI_TIMEOUT_HOLD_MS);
            this.holdTimers.add(timer);
            res.on("close", () => {
                clearTimeout(timer);
                this.holdTimers.delete(timer);
                this.held.delete(res);
            });
            return;
        }

        const content =
            response === "invalid" ?
                "this is not JSON {important: maybe"
            :   JSON.stringify({ ...DEFAULT_AI_VERDICT, ...response });

        const request = parseJSON(body) as { model?: string } | null;
        return sendJSON(res, 200, {
            id: `chatcmpl-sink-${this.seq}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: request?.model ?? "sink-stub",
            choices: [
                {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content },
                },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
    }
}

function flattenHeaders(req: IncomingMessage) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        out[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
}

function readBody(req: IncomingMessage) {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(chunk as Buffer));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function parseJSON(text: string): unknown {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function sendJSON(res: ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
}

let running: SinkServer | null = null;

export function sinkPort() {
    return Number(process.env.TEST_SINK_PORT ?? DEFAULT_SINK_PORT);
}

/** startSinks starts (or returns) the in-process sink server. */
export async function startSinks(port = sinkPort()) {
    if (running) return running;
    const server = new SinkServer();
    await server.start(port);
    running = server;
    return server;
}

export async function stopSinks() {
    const server = running;
    running = null;
    if (server) await server.stop();
}

const isMain =
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    const server = await startSinks();
    console.log(`sinks listening on :${server.port}`);
    const shutdown = () => {
        void stopSinks().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
