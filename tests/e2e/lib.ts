/**
 * Helpers for the end-to-end suite: everything a test does to the running
 * stack, through the same doors the product uses.
 *
 *   web app          sign-up, model connections, the object route
 *   PostgREST        Monitors and reads, as the test user (RLS applies)
 *   scheduler admin  Run now, Run status, plan again
 *   agent API        record a Macro
 *   Postgres         only what the web app does in server actions that a
 *                    script cannot call: storing a Monitor secret, approving
 *                    a draft Macro
 *   sample pages     flipping a fixture's variant
 *   sinks            reading what a webhook Channel received
 */
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { encryptSecret, secretHint } from "../../packages/db/src/vault";
import type {
    ChangeRecord,
    Macro,
    Monitor,
    ProviderConnection,
    RunStep,
    RunVerdict,
} from "../../packages/types/src/index";
import "../lib/load-env";
import { sinkPort, startSinks, type SinkRequest } from "../lib/sinks";
import { db, userJwt, webUrl, type TestUser } from "../lib/users";

const trim = (url: string) => url.replace(/\/+$/, "");

export const config = {
    webUrl: webUrl(),
    samplePagesUrl: trim(
        process.env.TEST_SAMPLE_PAGES_URL ?? "http://localhost:3003",
    ),
    postgrestUrl: trim(
        process.env.TEST_POSTGREST_URL ??
            process.env.NEXT_PUBLIC_POSTGREST_URL ??
            "http://localhost:5201",
    ),
    schedulerAdminUrl: trim(
        process.env.SCHEDULER_ADMIN_URL ?? "http://localhost:5210",
    ),
    schedulerAdminToken: process.env.SCHEDULER_ADMIN_TOKEN ?? "",
    agentUrl: trim(process.env.AGENT_URL ?? "http://127.0.0.1:5220"),
    agentToken: process.env.AGENT_TOKEN ?? "",
    objectStoreUrl: trim(process.env.R2_WORKER_URL ?? "http://localhost:8787"),
    sinkUrl: trim(
        process.env.TEST_SINK_URL ?? `http://localhost:${sinkPort()}`,
    ),
    /** A real, funded key. The suite is skipped without it. */
    openaiKey: process.env.TEST_OPENAI_API_KEY ?? "",
    /**
     * A current OpenAI model with vision and tool use, as the model gateway
     * names it on an own key at OpenAI's public endpoint.
     */
    model: gatewayModel(process.env.TEST_MODEL ?? "gpt-5.4-mini"),
};

function gatewayModel(model: string) {
    return model.includes("/") ? model : `openai/${model}`;
}

export function fixtureUrl(path: string) {
    return `${config.samplePagesUrl}/test/${path.replace(/^\/+/, "")}`;
}

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function expectOk(res: Response, what: string) {
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    throw new Error(`${what}: HTTP ${res.status} ${body.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

/**
 * Throws one error naming every service that is down, with the command that
 * starts it. The suite never starts services itself, except the sink server
 * that receives webhook Reactions (skipped with `sinks: false`).
 *
 * The suites share the fixture pages' variants, so run them one file at a
 * time: `pnpm test:e2e` does.
 */
export async function requireStack({ sinks = true }: { sinks?: boolean } = {}) {
    const probe = async (
        name: string,
        hint: string,
        url: string,
        init: RequestInit = {},
    ) => {
        try {
            const res = await fetch(url, {
                ...init,
                signal: AbortSignal.timeout(3_000),
            });
            return res.status < 500 ?
                    null
                :   `${name}: HTTP ${res.status}\n      start: ${hint}`;
        } catch (error) {
            return `${name}: ${error instanceof Error ? error.message : String(error)}\n      start: ${hint}`;
        }
    };
    const down = (
        await Promise.all([
            probe(
                "web app",
                "pnpm --filter @watchthatsite/web dev   (:3000)",
                `${config.webUrl}/api/auth/ok`,
            ),
            probe(
                "sample pages",
                "pnpm --filter @watchthatsite/sample-pages dev   (:3003)",
                `${config.samplePagesUrl}/test/api/diff-state`,
            ),
            probe(
                "postgrest",
                "make docker-up   (:5201)",
                `${config.postgrestUrl}/`,
            ),
            probe(
                "object store",
                "pnpm --filter @watchthatsite/cloudflare dev   (:8787)",
                `${config.objectStoreUrl}/health`,
            ),
            probe(
                "scheduler",
                "make run-scheduler-service   (admin API :5210)",
                `${config.schedulerAdminUrl}/internal/health`,
            ),
            probe(
                "browser worker",
                "make run-browser-worker   (agent API :5220)",
                `${config.agentUrl}/internal/health`,
            ),
        ])
    ).filter((line): line is string => line !== null);
    if (down.length > 0) {
        throw new Error(`stack not running:\n  ✗ ${down.join("\n  ✗ ")}`);
    }
    if (!config.schedulerAdminToken)
        throw new Error("SCHEDULER_ADMIN_TOKEN is not set");
    if (!config.agentToken) throw new Error("AGENT_TOKEN is not set");
    if (!sinks) return;
    const sink = await fetch(`${config.sinkUrl}/_health`).catch(() => null);
    if (!sink?.ok) await startSinks(sinkPort());
}

// ---------------------------------------------------------------------------
// PostgREST, as the user
// ---------------------------------------------------------------------------

async function postgrest(
    user: TestUser,
    path: string,
    init: RequestInit & { prefer?: string } = {},
) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await userJwt(user)}`);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (init.prefer) headers.set("prefer", init.prefer);
    return fetch(`${config.postgrestUrl}/${path.replace(/^\/+/, "")}`, {
        ...init,
        headers,
    });
}

export async function select<T>(user: TestUser, path: string): Promise<T[]> {
    return (await (
        await expectOk(await postgrest(user, path), `GET ${path}`)
    ).json()) as T[];
}

async function insert<T>(
    user: TestUser,
    table: string,
    rows: unknown,
): Promise<T[]> {
    const res = await postgrest(user, table, {
        method: "POST",
        body: JSON.stringify(rows),
        prefer: "return=representation",
    });
    return (await (await expectOk(res, `POST ${table}`)).json()) as T[];
}

// ---------------------------------------------------------------------------
// Model connections (web app API)
// ---------------------------------------------------------------------------

/** Adds the owner's OpenAI key as a connection, through the web app. */
export async function createConnection(
    user: TestUser,
): Promise<ProviderConnection> {
    const res = await fetch(`${config.webUrl}/api/connections`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: user.cookie,
            origin: new URL(config.webUrl).origin,
        },
        body: JSON.stringify({
            kind: "openai",
            name: "OpenAI (e2e)",
            apiKey: config.openaiKey,
        }),
    });
    const body = (await (
        await expectOk(res, "POST /api/connections")
    ).json()) as ProviderConnection | { connection: ProviderConnection };
    return "connection" in body ? body.connection : body;
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

export type MonitorInput = {
    name: string;
    /** A path under the sample pages' `/test/`, or a full URL. */
    url: string;
    instructions: string;
    connection_id: string;
    confirm_changes?: boolean;
};

/**
 * Inserts a Monitor owned by the user. `interval_minutes` is NULL, so the
 * minute tick never schedules it: every Run is started by the test.
 */
export async function createMonitor(
    user: TestUser,
    input: MonitorInput,
): Promise<Monitor> {
    const rows = await insert<Monitor>(user, "monitors", {
        user_id: user.id,
        name: input.name,
        url: /^https?:\/\//.test(input.url) ? input.url : fixtureUrl(input.url),
        interval_minutes: null,
        instructions: input.instructions,
        connection_id: input.connection_id,
        model: config.model,
        confirm_changes: input.confirm_changes ?? false,
    });
    return rows[0]!;
}

export async function getMonitor(user: TestUser, id: string): Promise<Monitor> {
    return (await select<Monitor>(user, `monitors?id=eq.${id}`))[0]!;
}

/** Stores a secret a Monitor's Macro may type, as the web app's action does. */
export async function putMonitorSecret(
    user: TestUser,
    monitorId: string,
    name: string,
    value: string,
) {
    const id = randomUUID();
    await db().query(
        "INSERT INTO secrets (id, user_id, purpose, ciphertext) VALUES ($1, $2, 'macro_secret', $3)",
        [id, user.id, encryptSecret(id, "macro_secret", value)],
    );
    await db().query(
        "INSERT INTO monitor_secrets (monitor_id, user_id, name, secret_id, hint) VALUES ($1, $2, $3, $4, $5)",
        [monitorId, user.id, name, id, secretHint(value)],
    );
}

// ---------------------------------------------------------------------------
// Runs (scheduler admin API)
// ---------------------------------------------------------------------------

async function admin<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${config.schedulerAdminToken}`);
    if (init.body) headers.set("content-type", "application/json");
    const res = await fetch(`${config.schedulerAdminUrl}${path}`, {
        ...init,
        headers,
    });
    return (await (
        await expectOk(res, `${init.method ?? "GET"} ${path}`)
    ).json()) as T;
}

export type RunResult = {
    run_id: string;
    monitor_id: string;
    status: "pending" | "processing" | "succeeded" | "failed";
    trigger: string;
    verdict: RunVerdict | null;
    summary: string | null;
    invalid_reason: string | null;
    error: { code: string; message: string } | null;
    change_id: string | null;
    macro_id: string | null;
    macro_status: "ok" | "repaired" | "failed" | null;
    input_tokens: number;
    output_tokens: number;
};

/** Starts a Run and waits until it succeeded or failed. */
export async function runAndWait(
    monitorId: string,
    {
        trigger = "manual",
        timeout = 240_000,
    }: { trigger?: "manual" | "confirm"; timeout?: number } = {},
): Promise<RunResult> {
    const { run_id } = await admin<{ run_id: string }>(
        `/internal/monitors/${monitorId}/runs`,
        {
            method: "POST",
            body: JSON.stringify({ trigger }),
        },
    );
    const started = Date.now();
    let last: RunResult | null = null;
    while (Date.now() - started < timeout) {
        last = await admin<RunResult>(`/internal/runs/${run_id}`);
        if (last.status === "succeeded" || last.status === "failed")
            return last;
        await sleep(750);
    }
    throw new Error(
        `Run ${run_id} did not finish within ${timeout} ms (last status ${last?.status})`,
    );
}

export async function runSteps(
    user: TestUser,
    runId: string,
): Promise<RunStep[]> {
    return select<RunStep>(user, `run_steps?run_id=eq.${runId}&order=seq.asc`);
}

// ---------------------------------------------------------------------------
// Changes and their records (PostgREST + the web object route)
// ---------------------------------------------------------------------------

export type ChangeRow = {
    id: string;
    run_id: string;
    status: "change" | "noise" | "pending";
    summary: string | null;
    suppressed_by: string[];
    item_count: number;
    record_key: string | null;
    notified_at: string | null;
};

export async function changeOf(
    user: TestUser,
    runId: string,
): Promise<ChangeRow | null> {
    return (
        (await select<ChangeRow>(user, `changes?run_id=eq.${runId}`))[0] ?? null
    );
}

/** Fetches an object through the web app, which checks the viewer owns it. */
export async function fetchObject(user: TestUser, key: string) {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return fetch(`${config.webUrl}/api/v1/objects/${encoded}?inline=1`, {
        headers: { cookie: user.cookie },
    });
}

export async function recordOf(
    user: TestUser,
    change: ChangeRow,
): Promise<ChangeRecord> {
    if (!change.record_key)
        throw new Error(`change ${change.id} has no record`);
    const res = await expectOk(
        await fetchObject(user, change.record_key),
        `object ${change.record_key}`,
    );
    let bytes = Buffer.from(await res.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    return JSON.parse(bytes.toString("utf8")) as ChangeRecord;
}

// ---------------------------------------------------------------------------
// Macros (agent API)
// ---------------------------------------------------------------------------

/** Asks the agent to record a Macro and waits for the draft (or the failure). */
export async function recordMacro(
    user: TestUser,
    monitorId: string,
    goal: string,
    timeout = 420_000,
): Promise<Macro> {
    const res = await fetch(`${config.agentUrl}/internal/macros/record`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.agentToken}`,
        },
        body: JSON.stringify({ monitor_id: monitorId, goal }),
    });
    const { macro_id } = (await (
        await expectOk(res, "POST /internal/macros/record")
    ).json()) as {
        macro_id: string;
    };
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const macro = (
            await select<Macro>(user, `macros?id=eq.${macro_id}`)
        )[0];
        if (macro && macro.status !== "recording") return macro;
        await sleep(1_500);
    }
    throw new Error(
        `recording ${macro_id} did not finish within ${timeout} ms`,
    );
}

/** Makes a draft the Monitor's active Macro, as the web app's approve action does. */
export async function approveMacro(macro: Pick<Macro, "id" | "monitor_id">) {
    const client = await db().connect();
    try {
        await client.query("BEGIN");
        await client.query(
            "UPDATE macros SET status = 'archived' WHERE monitor_id = $1 AND status = 'active'",
            [macro.monitor_id],
        );
        await client.query(
            "UPDATE macros SET status = 'active' WHERE id = $1",
            [macro.id],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function macrosOf(
    user: TestUser,
    monitorId: string,
): Promise<Macro[]> {
    return select<Macro>(
        user,
        `macros?monitor_id=eq.${monitorId}&order=version.asc`,
    );
}

// ---------------------------------------------------------------------------
// Fixtures and sinks
// ---------------------------------------------------------------------------

/** Switches what a fixture page serves. The Monitor's URL stays the same. */
export async function setVariant(scenario: string, variant: string) {
    const res = await fetch(`${config.samplePagesUrl}/test/api/diff-state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, variant }),
    });
    await expectOk(res, `set ${scenario}=${variant}`);
}

/** Adds a webhook Channel that delivers to the sink server. */
export async function createWebhookChannel(user: TestUser): Promise<string> {
    const path = `/webhook/${randomUUID()}`;
    await insert(user, "notification_config", {
        user_id: user.id,
        enabled: true,
        channel_id: "webhook",
        name: "webhook",
        credentials: {
            endpoints: [
                {
                    url: `${config.sinkUrl}${path}`,
                    secret: `whsec_${randomUUID().replaceAll("-", "")}`,
                },
            ],
        },
    });
    return path;
}

/** Waits for the sink to have received at least `count` requests on a path. */
export async function sinkRequests(
    path: string,
    count = 1,
    timeout = 20_000,
): Promise<SinkRequest[]> {
    const started = Date.now();
    let requests: SinkRequest[] = [];
    while (Date.now() - started < timeout) {
        const res = await fetch(
            `${config.sinkUrl}/_requests?path=${encodeURIComponent(path)}`,
        );
        requests = ((await res.json()) as { requests: SinkRequest[] }).requests;
        if (requests.length >= count) return requests;
        await sleep(500);
    }
    return requests;
}
