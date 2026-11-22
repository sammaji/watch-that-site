import {
    WATCH_HOWS,
    type AgentError,
    type CompareRequest,
    type CompareResponse,
    type MacroStep,
    type PlanLoad,
    type PlanRequest,
    type PlanResponse,
    type RecordMacroRequest,
    type RecordMacroResponse,
    type RunRef,
    type SuggestRequest,
    type SuggestResponse,
    type TestMacroResponse,
    type WatchPlan,
} from "@watchthatsite/types";
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { AgentJobError } from "../agent/job.js";
import { ProviderError } from "../agent/providers/errors.js";
import { maxRequestBytes } from "../config/constants.js";
import { UUID } from "../handler/scrape-job.js";
import { InvalidSteps, parseSteps } from "../macro/validate.js";
import { NoConnectionError } from "../store/store.js";

/**
 * The agent API: a small HTTP server next to the AMQP consumers.
 *
 *   GET  /internal/health          open
 *   POST /internal/compare         scheduler: is this difference a Change?
 *   POST /internal/plan            scheduler: make a Watch Plan
 *   POST /internal/macros/record   web app: record a Macro from a goal
 *   POST /internal/macros/test     web app: replay steps once
 *   POST /internal/suggest         web app: name and Instructions for a URL
 *
 * Everything but health needs `Authorization: Bearer $AGENT_TOKEN`. Bodies
 * and errors are in `@watchthatsite/types` (protocol.ts).
 */

/** What the routes do; the composition root wires these to the agent jobs. */
export interface AgentApi {
    compare(req: CompareRequest): Promise<CompareResponse>;
    plan(req: PlanRequest): Promise<PlanResponse>;
    record(req: RecordMacroRequest): Promise<RecordMacroResponse>;
    testMacro(
        monitorId: string,
        steps: MacroStep[],
    ): Promise<TestMacroResponse>;
    suggest(req: SuggestRequest): Promise<SuggestResponse>;
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "HttpError";
    }
}

const bad = (message: string): never => {
    throw new HttpError(400, "bad_request", message);
};

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function uuid(v: unknown, field: string): string {
    if (typeof v !== "string" || !UUID.test(v))
        return bad(`${field} must be a UUID`);
    return v.toLowerCase();
}

function str(v: unknown, field: string, max = 20_000): string {
    if (typeof v !== "string" || v.length > max) {
        return bad(`${field} must be a string of at most ${max} characters`);
    }
    return v;
}

function nullable<T>(v: unknown, parse: (v: unknown) => T): T | null {
    return v === null || v === undefined ? null : parse(v);
}

function size(v: unknown, field: string): [number, number] {
    if (
        !Array.isArray(v) ||
        v.length !== 2 ||
        !v.every(n => typeof n === "number" && n >= 0)
    ) {
        return bad(`${field} must be [w, h]`);
    }
    return [v[0] as number, v[1] as number];
}

/** A Capture reference whose object keys belong to the Monitor of the request. */
function runRef(v: unknown, field: string, monitorId: string): RunRef {
    if (!isObject(v)) return bad(`${field} must be an object`);
    const key = (value: unknown, name: string): string => {
        const k = str(value ?? "", `${field}.${name}`, 300);
        // The routes read these keys from the object store; a caller must
        // not be able to point them at another Monitor's Captures.
        if (k !== "" && !k.startsWith(`captures/${monitorId}/`)) {
            return bad(
                `${field}.${name} must be a Capture object of this Monitor`,
            );
        }
        return k;
    };
    return {
        run_id: uuid(v.run_id, `${field}.run_id`),
        at: str(v.at ?? "", `${field}.at`, 64),
        screenshot: key(v.screenshot, "screenshot"),
        blocks: key(v.blocks, "blocks"),
    };
}

function monitorRef(v: unknown): {
    name: string;
    url: string;
    instructions: string;
} {
    if (!isObject(v)) return bad("monitor must be an object");
    return {
        name: str(v.name, "monitor.name", 500),
        url: str(v.url, "monitor.url", 4000),
        instructions: str(v.instructions ?? "", "monitor.instructions"),
    };
}

function watchPlan(v: unknown, field: string): WatchPlan {
    if (!isObject(v) || !Array.isArray(v.sections))
        return bad(`${field} must be a Watch Plan`);
    const how = (value: unknown, name: string) =>
        WATCH_HOWS.includes(value as never) ?
            (value as WatchPlan["rest"])
        :   bad(`${name} must be one of ${WATCH_HOWS.join(", ")}`);
    return {
        version: 1,
        sections: v.sections.map((s, i) => {
            const at = `${field}.sections[${i}]`;
            if (!isObject(s)) return bad(`${at} must be an object`);
            if (
                !Array.isArray(s.paths) ||
                !s.paths.every(p => typeof p === "string")
            ) {
                return bad(`${at}.paths must be an array of strings`);
            }
            return {
                id: str(s.id, `${at}.id`, 100),
                name: str(s.name, `${at}.name`, 200),
                how: how(s.how, `${at}.how`),
                why: str(s.why ?? "", `${at}.why`, 1000),
                paths: s.paths as string[],
            };
        }),
        rest: how(v.rest, `${field}.rest`),
        summary: str(v.summary ?? "", `${field}.summary`, 2000),
        instructions_hash: str(
            v.instructions_hash ?? "",
            `${field}.instructions_hash`,
            100,
        ),
        run_id: str(v.run_id ?? "", `${field}.run_id`, 64),
        model: str(v.model ?? "", `${field}.model`, 200),
        created_at: str(v.created_at ?? "", `${field}.created_at`, 64),
    };
}

/** Who and what an agent job is for: the first fields of every scheduler request. */
function subject(body: Record<string, unknown>) {
    return {
        run_id: uuid(body.run_id, "run_id"),
        monitor_id: uuid(body.monitor_id, "monitor_id"),
        user_id:
            str(body.user_id, "user_id", 200) ||
            bad("user_id must not be empty"),
        monitor: monitorRef(body.monitor),
        connection_id: nullable(body.connection_id, v =>
            uuid(v, "connection_id"),
        ),
        model: nullable(body.model, v => str(v, "model", 200)),
    };
}

export function parseCompareRequest(body: unknown): CompareRequest {
    if (!isObject(body)) return bad("the body must be a JSON object");
    const base = subject(body);

    let text: CompareRequest["text"] = null;
    if (body.text !== null && body.text !== undefined) {
        const t = body.text;
        if (!isObject(t) || !Array.isArray(t.ops))
            return bad("text.ops must be an array");
        if (t.ops.length > 20_000) bad("text.ops holds too many ops");
        t.ops.forEach((op, i) => {
            if (
                !isObject(op) ||
                typeof op.op !== "string" ||
                typeof op.path !== "string"
            ) {
                bad(`text.ops[${i}] must have op and path`);
            }
        });
        text = t as unknown as CompareRequest["text"];
    }

    if (!Array.isArray(body.regions)) return bad("regions must be an array");
    if (body.regions.length > 1_000) bad("regions holds too many regions");
    const regions = body.regions.map((r, i) => {
        if (
            !isObject(r) ||
            !Array.isArray(r.box) ||
            r.box.length !== 4 ||
            !r.box.every(n => typeof n === "number" && Number.isFinite(n))
        ) {
            return bad(`regions[${i}].box must be [x, y, w, h]`);
        }
        const from = r.from_box ?? null;
        if (
            from !== null &&
            (!Array.isArray(from) ||
                from.length !== 4 ||
                !from.every(n => typeof n === "number" && Number.isFinite(n)))
        ) {
            return bad(`regions[${i}].from_box must be [x, y, w, h] or null`);
        }
        return {
            box: r.box as [number, number, number, number],
            from_box: from as [number, number, number, number] | null,
            kind: str(r.kind ?? "changed", `regions[${i}].kind`, 40),
            pixels: typeof r.pixels === "number" ? r.pixels : 0,
            section: typeof r.section === "string" ? r.section : "",
        };
    });

    const feedback = (Array.isArray(body.feedback) ? body.feedback : []).map(
        (f, i) => {
            if (
                !isObject(f) ||
                (f.feedback !== "useful" && f.feedback !== "noise")
            ) {
                return bad(`feedback[${i}].feedback must be useful or noise`);
            }
            return {
                summary: str(f.summary ?? "", `feedback[${i}].summary`, 2000),
                feedback: f.feedback as "useful" | "noise",
            };
        },
    );

    return {
        ...base,
        from: runRef(body.from, "from", base.monitor_id),
        to: runRef(body.to, "to", base.monitor_id),
        text,
        regions,
        plan: nullable(body.plan, v => watchPlan(v, "plan")),
        size_before: size(body.size_before ?? [0, 0], "size_before"),
        size_after: size(body.size_after ?? [0, 0], "size_after"),
        feedback,
    };
}

export function parsePlanRequest(body: unknown): PlanRequest {
    if (!isObject(body)) return bad("the body must be a JSON object");
    const base = subject(body);
    return {
        ...base,
        capture: runRef(body.capture, "capture", base.monitor_id),
        size: size(body.size ?? [0, 0], "size"),
        previous: nullable(body.previous, v => watchPlan(v, "previous")),
        load: nullable(body.load, planLoad),
    };
}

/** How the page loaded; lenient, since it only informs the model. */
function planLoad(v: unknown): PlanLoad {
    if (!isObject(v)) return bad("load must be an object");
    const n = (x: unknown) =>
        typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : 0;
    return {
        load_ms: n(v.load_ms),
        settle_ms: n(v.settle_ms),
        network_quiet: v.network_quiet === true,
        stable: v.stable === true,
        moving_regions: n(v.moving_regions),
        wait_ms: n(v.wait_ms),
    };
}

function parseSuggestRequest(body: unknown): SuggestRequest {
    if (!isObject(body)) return bad("the body must be a JSON object");
    const url = str(body.url, "url", 2048);
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return bad("url must be http or https");
        }
    } catch {
        return bad("url is not a valid URL");
    }
    return { user_id: str(body.user_id, "user_id", 200), url };
}

function parseRecordRequest(body: unknown): RecordMacroRequest {
    if (!isObject(body)) return bad("the body must be a JSON object");
    const goal = str(body.goal, "goal", 2_000).trim();
    if (goal === "") bad("goal must not be empty");
    return { monitor_id: uuid(body.monitor_id, "monitor_id"), goal };
}

function parseTestRequest(body: unknown): {
    monitorId: string;
    steps: MacroStep[];
} {
    if (!isObject(body)) return bad("the body must be a JSON object");
    try {
        return {
            monitorId: uuid(body.monitor_id, "monitor_id"),
            steps: parseSteps(body.steps),
        };
    } catch (err) {
        if (err instanceof InvalidSteps) return bad(err.message);
        throw err;
    }
}

/** Compares in constant time, whatever the lengths. */
function sameToken(given: string, expected: string): boolean {
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        total += (chunk as Buffer).length;
        if (total > maxRequestBytes) {
            throw new HttpError(
                413,
                "bad_request",
                "The request body is too large",
            );
        }
        chunks.push(chunk as Buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return bad("The request body is not valid JSON");
    }
}

/** The status and AgentError a failure is reported with. */
export function toAgentError(err: unknown): {
    status: number;
    body: AgentError;
} {
    const make = (status: number, code: string, message: string) => ({
        status,
        body: { error: { code, message } },
    });
    if (err instanceof HttpError)
        return make(err.status, err.code, err.message);
    if (err instanceof NoConnectionError)
        return make(409, "no_connection", err.message);
    if (err instanceof ProviderError)
        return make(502, "provider_error", err.message);
    if (err instanceof AgentJobError) {
        const status =
            err.code === "not_found" ? 404
            : err.code === "bad_request" ? 400
            : err.code === "provider_error" ? 502
            : 500;
        return make(status, err.code, err.message);
    }
    return make(500, "internal_error", "The agent API hit an unexpected error");
}

/**
 * Builds the server. Without a token only the health route is served: the
 * others would let anyone on the network spend the owners' model keys and
 * drive a browser, so they stay off until AGENT_TOKEN is set.
 */
export function createAgentServer(opts: {
    api: AgentApi;
    token: string | undefined;
    logger: Logger;
}): http.Server {
    const { api, logger } = opts;
    const token = opts.token?.trim() || "";

    const routes: Record<string, (body: unknown) => Promise<unknown>> = {
        "/internal/compare": body => api.compare(parseCompareRequest(body)),
        "/internal/plan": body => api.plan(parsePlanRequest(body)),
        "/internal/suggest": body => api.suggest(parseSuggestRequest(body)),
        "/internal/macros/record": body => api.record(parseRecordRequest(body)),
        "/internal/macros/test": body => {
            const { monitorId, steps } = parseTestRequest(body);
            return api.testMacro(monitorId, steps);
        },
    };

    return http.createServer((req, res) => {
        const send = (status: number, body: unknown) => {
            const json = JSON.stringify(body);
            res.writeHead(status, {
                "content-type": "application/json; charset=utf-8",
                "content-length": Buffer.byteLength(json),
            });
            res.end(json);
        };
        const path = new URL(req.url ?? "/", "http://agent").pathname;
        const started = Date.now();

        void (async () => {
            if (path === "/internal/health") {
                if (req.method !== "GET" && req.method !== "HEAD") {
                    throw new HttpError(405, "bad_request", "Use GET");
                }
                return send(200, { ok: true, routes: token !== "" });
            }
            const route = routes[path];
            if (!route) throw new HttpError(404, "not_found", "No such route");
            if (token === "") {
                throw new HttpError(
                    503,
                    "internal_error",
                    "The agent API is off because AGENT_TOKEN is not set on the browser worker",
                );
            }
            const header = req.headers.authorization ?? "";
            const given = /^Bearer (.+)$/i.exec(header)?.[1] ?? "";
            if (given === "" || !sameToken(given, token)) {
                throw new HttpError(
                    401,
                    "unauthorized",
                    "A valid bearer token is required",
                );
            }
            if (req.method !== "POST")
                throw new HttpError(405, "bad_request", "Use POST");

            const result = await route(await readJson(req));
            logger.info({ path, ms: Date.now() - started }, "[agent-api] ok");
            send(200, result);
        })().catch((err: unknown) => {
            const { status, body } = toAgentError(err);
            if (status >= 500 && body.error.code === "internal_error") {
                logger.error({ err, path }, "[agent-api] request failed");
            } else {
                logger.info(
                    {
                        path,
                        status,
                        code: body.error.code,
                        ms: Date.now() - started,
                    },
                    "[agent-api] request refused",
                );
            }
            if (!res.headersSent) send(status, body);
            else res.end();
        });
    });
}

/** `host:port`, with the default host for a bare `:port` or port. */
export function parseAddr(addr: string): { host: string; port: number } {
    const m = /^(?:(.*):)?(\d+)$/.exec(addr.trim());
    if (!m)
        throw new Error(
            `AGENT_ADDR must be host:port, got ${JSON.stringify(addr)}`,
        );
    return { host: m[1] || "127.0.0.1", port: Number(m[2]) };
}

export async function listen(
    server: http.Server,
    addr: string,
): Promise<{ host: string; port: number }> {
    const { host, port } = parseAddr(addr);
    // Node closes an idle keep-alive connection after 5 s by default; the
    // scheduler drops its idle connections after 2 s. Keeping ours open
    // longer than the client's means a reused connection is never one this
    // side has just closed.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return { host, port: (server.address() as AddressInfo).port };
}

/** Stops accepting requests and waits for the ones in flight, up to `graceMs`. */
export async function closeServer(
    server: http.Server,
    graceMs = 10_000,
): Promise<void> {
    await new Promise<void>(resolve => {
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        force.unref();
        server.close(() => {
            clearTimeout(force);
            resolve();
        });
        server.closeIdleConnections();
    });
}
