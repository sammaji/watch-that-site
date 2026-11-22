import type {
    CompareRequest,
    CompareResponse,
    MacroStep,
    PlanRequest,
    TestMacroResponse,
} from "@watchthatsite/types";
import type http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentJobError } from "../agent/job.js";
import { ProviderError } from "../agent/providers/errors.js";
import type { BrowserPool } from "../lib/browser-pool.js";
import { testMacro } from "../macro/test.js";
import { NoConnectionError } from "../store/store.js";
import type { LooseJson } from "../testing/fake-provider.js";
import { FakeStore } from "../testing/fake-store.js";
import {
    launchPool,
    MemoryStore,
    MONITOR_ID,
    noBlockers,
    RUN_ID,
    silentLogger,
} from "../testing/harness.js";
import {
    SITE_EMAIL,
    SITE_PASSWORD,
    startAccountSite,
    type AccountSite,
} from "../testing/site.js";
import {
    closeServer,
    createAgentServer,
    listen,
    parseAddr,
    type AgentApi,
} from "./server.js";

const TOKEN = "test-agent-token-4f9c";
const OTHER_MONITOR = "5a0e7c3e-9a1f-4a53-8d1c-6f6f0f3d2b11";

const compareBody = (): CompareRequest => ({
    run_id: RUN_ID,
    monitor_id: MONITOR_ID,
    user_id: "user-1",
    monitor: {
        name: "Acme",
        url: "https://acme.test/",
        instructions: "Prices.",
    },
    connection_id: null,
    model: null,
    from: {
        run_id: RUN_ID,
        at: "2026-11-20T10:00:00Z",
        screenshot: `captures/${MONITOR_ID}/${RUN_ID}/shot.webp`,
        blocks: `captures/${MONITOR_ID}/${RUN_ID}/blocks.json.gz`,
    },
    to: {
        run_id: RUN_ID,
        at: "2026-11-21T10:00:00Z",
        screenshot: "",
        blocks: "",
    },
    text: {
        ops: [
            {
                op: "add",
                path: "/html[1]/body[1]/p[1]",
                from: -1,
                to: 0,
                text: "New",
            },
        ],
        ignored_count: 0,
        masked: [],
    },
    regions: [
        {
            box: [0, 0, 10, 10],
            from_box: [0, 0, 10, 10],
            kind: "changed",
            pixels: 100,
            section: "",
        },
    ],
    plan: null,
    size_before: [800, 600],
    size_after: [800, 600],
    feedback: [],
});

const answer: CompareResponse = {
    relevant: true,
    importance: "low",
    summary: "A line was added.",
    items: [],
    ignored: [],
    model: "m",
    input_tokens: 1,
    output_tokens: 1,
    steps: 1,
};

describe("the agent API", () => {
    let server: http.Server;
    let origin: string;
    let seen: {
        compare: CompareRequest[];
        plan: PlanRequest[];
        record: unknown[];
        test: { monitorId: string; steps: MacroStep[] }[];
    };
    let api: AgentApi;

    beforeEach(async () => {
        seen = { compare: [], plan: [], record: [], test: [] };
        api = {
            suggest: () => Promise.reject(new Error("not used here")),
            compare: async req => {
                seen.compare.push(req);
                return answer;
            },
            plan: async req => {
                seen.plan.push(req);
                return {
                    sections: [],
                    rest: "text",
                    summary: "s",
                    wait_ms: 0,
                    model: "m",
                    input_tokens: 1,
                    output_tokens: 1,
                    steps: 1,
                };
            },
            record: async req => {
                seen.record.push(req);
                return { macro_id: "0b0f6a52-3c58-4d1e-9d5f-4f1f1b9f3a11" };
            },
            testMacro: async (monitorId, steps) => {
                seen.test.push({ monitorId, steps });
                return {
                    ok: true,
                    failed_step: null,
                    error: "",
                    steps: [],
                    screenshot_key: null,
                };
            },
        };
        server = createAgentServer({
            api: {
                suggest: r => api.suggest(r),
                compare: r => api.compare(r),
                plan: r => api.plan(r),
                record: r => api.record(r),
                testMacro: (m, s) => api.testMacro(m, s),
            },
            token: TOKEN,
            logger: silentLogger,
        });
        const bound = await listen(server, "127.0.0.1:0");
        origin = `http://127.0.0.1:${bound.port}`;
        return () => closeServer(server, 100);
    });

    const call = (
        path: string,
        body?: unknown,
        opts: { token?: string | null; method?: string } = {},
    ) =>
        fetch(`${origin}${path}`, {
            method: opts.method ?? (body === undefined ? "GET" : "POST"),
            headers: {
                ...(opts.token === null ?
                    {}
                :   { authorization: `Bearer ${opts.token ?? TOKEN}` }),
                ...(body === undefined ?
                    {}
                :   { "content-type": "application/json" }),
            },
            ...(body === undefined ?
                {}
            :   {
                    body:
                        typeof body === "string" ? body : JSON.stringify(body),
                }),
        });

    it("serves health without a token", async () => {
        const res = await call("/internal/health", undefined, { token: null });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, routes: true });
    });

    it("refuses every other route without the right bearer token", async () => {
        for (const path of [
            "/internal/compare",
            "/internal/plan",
            "/internal/macros/record",
            "/internal/macros/test",
        ]) {
            for (const token of [null, "wrong", `${TOKEN}x`, ""]) {
                const res = await call(path, compareBody(), { token });
                expect(res.status, `${path} with ${String(token)}`).toBe(401);
                expect(await res.json()).toEqual({
                    error: {
                        code: "unauthorized",
                        message: "A valid bearer token is required",
                    },
                });
            }
        }
        expect(seen.compare).toHaveLength(0);
    });

    it("answers 404 for an unknown route and 405 for the wrong method", async () => {
        expect((await call("/internal/nope", {})).status).toBe(404);
        expect(
            (await call("/internal/compare", undefined, { method: "GET" }))
                .status,
        ).toBe(405);
    });

    it("passes a valid compare request through and returns the answer", async () => {
        const res = await call("/internal/compare", compareBody());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(answer);
        expect(seen.compare[0]).toEqual(compareBody());
    });

    it("rejects malformed compare requests with bad_request", async () => {
        const bad = async (mutate: (b: LooseJson) => void, message: RegExp) => {
            const body = compareBody() as unknown as LooseJson;
            mutate(body);
            const res = await call("/internal/compare", body);
            expect(res.status).toBe(400);
            const json = (await res.json()) as {
                error: { code: string; message: string };
            };
            expect(json.error.code).toBe("bad_request");
            expect(json.error.message).toMatch(message);
        };
        await bad(b => (b.run_id = "run-1"), /run_id must be a UUID/);
        await bad(b => (b.user_id = ""), /user_id must not be empty/);
        await bad(b => delete b.monitor, /monitor must be an object/);
        await bad(
            b => (b.regions = [{ box: [1, 2, 3] }]),
            /regions\[0\]\.box must be \[x, y, w, h\]/,
        );
        await bad(
            b => (b.text = { ops: [{ op: "add" }] }),
            /text\.ops\[0\] must have op and path/,
        );
        await bad(
            b => (b.feedback = [{ summary: "x", feedback: "meh" }]),
            /feedback\[0\]\.feedback must be useful or noise/,
        );
        await bad(
            b =>
                (b.plan = {
                    sections: [
                        {
                            id: "a",
                            name: "A",
                            how: "closely",
                            why: "",
                            paths: [],
                        },
                    ],
                    rest: "text",
                }),
            /plan\.sections\[0\]\.how must be one of/,
        );
        // A caller cannot point the Agent at another Monitor's Captures.
        await bad(
            b =>
                (b.from.screenshot = `captures/${OTHER_MONITOR}/${RUN_ID}/shot.webp`),
            /from\.screenshot must be a Capture object of this Monitor/,
        );
        await bad(
            b => (b.to.blocks = "state/whatever.json"),
            /to\.blocks must be a Capture object of this Monitor/,
        );

        const notJson = await call("/internal/compare", "{nope");
        expect(notJson.status).toBe(400);
        expect(seen.compare).toHaveLength(0);
    });

    it("validates plan, record and test requests", async () => {
        const planBody = {
            ...compareBody(),
            capture: compareBody().from,
            size: [800, 600],
            previous: null,
        };
        expect((await call("/internal/plan", planBody)).status).toBe(200);
        expect(seen.plan[0]).toMatchObject({
            monitor_id: MONITOR_ID,
            capture: compareBody().from,
            size: [800, 600],
            previous: null,
        });
        expect(
            (await call("/internal/plan", { ...planBody, capture: null }))
                .status,
        ).toBe(400);

        const record = await call("/internal/macros/record", {
            monitor_id: MONITOR_ID,
            goal: "  Sign in  ",
        });
        expect(await record.json()).toEqual({
            macro_id: "0b0f6a52-3c58-4d1e-9d5f-4f1f1b9f3a11",
        });
        expect(seen.record[0]).toEqual({
            monitor_id: MONITOR_ID,
            goal: "Sign in",
        });
        expect(
            (
                await call("/internal/macros/record", {
                    monitor_id: MONITOR_ID,
                    goal: "  ",
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await call("/internal/macros/record", {
                    monitor_id: "m",
                    goal: "x",
                })
            ).status,
        ).toBe(400);

        const steps: MacroStep[] = [
            {
                type: "click",
                intent: "Open Billing",
                selectors: ["text=Billing"],
            },
        ];
        expect(
            (
                await call("/internal/macros/test", {
                    monitor_id: MONITOR_ID,
                    steps,
                })
            ).status,
        ).toBe(200);
        expect(seen.test[0]).toEqual({ monitorId: MONITOR_ID, steps });

        const invalid = async (steps: unknown, message: RegExp) => {
            const res = await call("/internal/macros/test", {
                monitor_id: MONITOR_ID,
                steps,
            });
            expect(res.status).toBe(400);
            expect(
                ((await res.json()) as { error: { message: string } }).error
                    .message,
            ).toMatch(message);
        };
        await invalid([], /steps must not be empty/);
        await invalid(
            Array.from({ length: 41 }, () => steps[0]),
            /at most 40 steps/,
        );
        await invalid(
            [{ type: "hover", selectors: ["a"] }],
            /steps\[0\]: type must be one of/,
        );
        await invalid(
            [{ type: "click", intent: "x" }],
            /steps\[0\]: selectors are required/,
        );
        await invalid(
            [{ type: "navigate", intent: "x", url: "file:///etc/passwd" }],
            /url must be an http\(s\) URL/,
        );
        await invalid(
            [{ type: "fill", intent: "x", selectors: ["a"] }],
            /value must be a string/,
        );
        await invalid(
            [{ type: "wait", intent: "x", ms: 999_999 }],
            /ms must be a number from 0 to 30000/,
        );
        await invalid(
            [{ type: "wait_for", intent: "x" }],
            /needs selectors or text/,
        );
        await invalid(
            [{ type: "click", intent: "x", selectors: ["a"], timeout_ms: -5 }],
            /timeout_ms/,
        );
    });

    it("maps failures to the AgentError codes", async () => {
        const failing = async (error: Error) => {
            api.compare = async () => {
                throw error;
            };
            const res = await call("/internal/compare", compareBody());
            return {
                status: res.status,
                ...(
                    (await res.json()) as {
                        error: { code: string; message: string };
                    }
                ).error,
            };
        };
        expect(await failing(new NoConnectionError())).toMatchObject({
            status: 409,
            code: "no_connection",
        });
        expect(
            await failing(
                new ProviderError("The provider rejected the API key: nope", {
                    status: 401,
                }),
            ),
        ).toEqual({
            status: 502,
            code: "provider_error",
            message: "The provider rejected the API key: nope",
        });
        expect(
            await failing(
                new AgentJobError("not_found", "There is no such Monitor"),
            ),
        ).toMatchObject({ status: 404, code: "not_found" });
        expect(
            await failing(
                new AgentJobError(
                    "provider_error",
                    "The model did not give an answer within 12 turns",
                ),
            ),
        ).toMatchObject({ status: 502, code: "provider_error" });
        // An unexpected error says nothing about what went wrong inside.
        expect(
            await failing(
                new Error(
                    "connect ECONNREFUSED 10.0.0.5:5432 password=hunter2",
                ),
            ),
        ).toEqual({
            status: 500,
            code: "internal_error",
            message: "The agent API hit an unexpected error",
        });
    });

    it("serves only health when no token is configured", async () => {
        const open = createAgentServer({
            api,
            token: undefined,
            logger: silentLogger,
        });
        const bound = await listen(open, "127.0.0.1:0");
        try {
            const base = `http://127.0.0.1:${bound.port}`;
            expect(
                await (await fetch(`${base}/internal/health`)).json(),
            ).toEqual({ ok: true, routes: false });
            for (const auth of [
                undefined,
                "Bearer ",
                "Bearer undefined",
                `Bearer ${TOKEN}`,
            ]) {
                const res = await fetch(`${base}/internal/compare`, {
                    method: "POST",
                    headers: auth ? { authorization: auth } : {},
                    body: JSON.stringify(compareBody()),
                });
                expect(res.status).toBe(503);
                expect(
                    ((await res.json()) as { error: { message: string } }).error
                        .message,
                ).toContain("AGENT_TOKEN is not set");
            }
            expect(seen.compare).toHaveLength(0);
        } finally {
            await closeServer(open, 100);
        }
    });

    it("parses AGENT_ADDR", () => {
        expect(parseAddr("127.0.0.1:5220")).toEqual({
            host: "127.0.0.1",
            port: 5220,
        });
        expect(parseAddr("0.0.0.0:80")).toEqual({ host: "0.0.0.0", port: 80 });
        expect(parseAddr(":5220")).toEqual({ host: "127.0.0.1", port: 5220 });
        expect(() => parseAddr("localhost")).toThrow(/host:port/);
    });
});

describe("POST /internal/macros/test, end to end", () => {
    let site: AccountSite;
    let pool: BrowserPool;
    let server: http.Server;
    let origin: string;
    let db: FakeStore;
    let objects: MemoryStore;

    beforeAll(async () => {
        site = await startAccountSite();
        pool = await launchPool();
        db = new FakeStore();
        objects = new MemoryStore();
        db.addMonitor(MONITOR_ID, `${site.origin}/app`);
        db.setSecret(MONITOR_ID, "password", SITE_PASSWORD);
        server = createAgentServer({
            token: TOKEN,
            logger: silentLogger,
            api: {
                suggest: () => Promise.reject(new Error("not used here")),
                compare: async () => answer,
                plan: async () => {
                    throw new Error("unused");
                },
                record: async () => {
                    throw new Error("unused");
                },
                testMacro: async (monitorId, steps) => {
                    const monitor = await db.getMonitor(monitorId);
                    if (!monitor)
                        throw new AgentJobError(
                            "not_found",
                            "There is no such Monitor",
                        );
                    return testMacro(
                        {
                            store: db,
                            pool,
                            blockers: noBlockers,
                            objectStore: objects,
                            logger: silentLogger,
                        },
                        monitor,
                        steps,
                    );
                },
            },
        });
        origin = `http://127.0.0.1:${(await listen(server, "127.0.0.1:0")).port}`;
    });

    afterAll(async () => {
        await closeServer(server, 100);
        await pool?.close();
        await site?.close();
    });

    const test = async (steps: MacroStep[], monitorId = MONITOR_ID) => {
        const res = await fetch(`${origin}/internal/macros/test`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${TOKEN}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ monitor_id: monitorId, steps }),
        });
        return {
            status: res.status,
            body: (await res.json()) as TestMacroResponse & { error?: unknown },
        };
    };

    const signIn: MacroStep[] = [
        {
            type: "fill",
            intent: "Type the email",
            selectors: ['label="Email"'],
            value: SITE_EMAIL,
        },
        {
            type: "fill",
            intent: "Type the password",
            selectors: ['label="Password"'],
            value: "{{secret:password}}",
        },
        {
            type: "click",
            intent: "Sign in",
            selectors: ["css=#nope", 'role=button[name="Sign in"]'],
        },
    ];

    it("replays the steps in a fresh browser with the Monitor's secrets", async () => {
        const { status, body } = await test([
            ...signIn,
            {
                type: "click",
                intent: "Open the Billing tab",
                selectors: ['role=tab[name="Billing"]'],
            },
        ]);
        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, failed_step: null, error: "" });
        expect(body.steps.map(s => [s.status, s.selector, s.error])).toEqual([
            ["ok", 'label="Email"', ""],
            ["ok", 'label="Password"', ""],
            ["ok", 'role=button[name="Sign in"]', ""],
            ["ok", 'role=tab[name="Billing"]', ""],
        ]);
        expect(body.steps.every(s => s.duration_ms >= 0)).toBe(true);
        // A screenshot of where the replay ended, under the Monitor's own prefix.
        expect(body.screenshot_key).toMatch(
            new RegExp(`^steps/${MONITOR_ID}/[0-9a-f-]{36}/3\\.webp$`),
        );
        expect(objects.objects.get(body.screenshot_key!)?.contentType).toBe(
            "image/webp",
        );
        expect(JSON.stringify(body)).not.toContain(SITE_PASSWORD);
    });

    it("reports the step that failed, and stops there", async () => {
        const { body } = await test([
            ...signIn,
            {
                type: "click",
                intent: "Open Invoices",
                selectors: ["text=Invoices"],
                timeout_ms: 500,
            },
            {
                type: "click",
                intent: "Open the Billing tab",
                selectors: ['role=tab[name="Billing"]'],
            },
        ]);
        expect(body).toMatchObject({
            ok: false,
            failed_step: 3,
            error: "Step 4 (Open Invoices) could not be completed: no element matched",
        });
        expect(body.steps.map(s => s.status)).toEqual([
            "ok",
            "ok",
            "ok",
            "failed",
        ]);
        expect(body.screenshot_key).toMatch(/\/3\.webp$/);
    });

    it("answers not_found for a Monitor that does not exist", async () => {
        const { status, body } = await test(
            signIn,
            "11111111-2222-4333-8444-555555555555",
        );
        expect(status).toBe(404);
        expect(body.error).toMatchObject({ code: "not_found" });
    });
});
