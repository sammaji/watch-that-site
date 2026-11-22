import type { Capture, ScrapeJob } from "@watchthatsite/types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserPool } from "../lib/browser-pool.js";
import { createMacroRunner } from "../macro/run.js";
import { FakeStore } from "../testing/fake-store.js";
import {
    deps,
    html,
    launchPool,
    makeJob,
    MemoryStore,
    MONITOR_ID,
    RUN_ID,
    startServer,
    type FixtureServer,
} from "../testing/harness.js";
import { createScrapeJobHandler, parseScrapeJob } from "./scrape-job.js";

/**
 * The JSON field names of Capture v3 (packages/types/src/protocol.ts), which
 * the scheduler decodes with unknown fields disallowed. `null` marks a leaf.
 */
type Shape = null | { [field: string]: Shape } | { "[]": Shape };

const rect: Shape = null;
const blockShape: Shape = { id: null, path: null, tag: null, text: null, rect };
const screenshotShape: Shape = { key: null, w: null, h: null, format: null };
const captureShape: Shape = {
    version: null,
    run_id: null,
    monitor_id: null,
    status: null,
    invalid_reason: null,
    error: { message: null },
    blocks: { "[]": blockShape },
    truncated: null,
    screenshot: screenshotShape,
    masks: { "[]": rect },
    meta: {
        http_status: null,
        final_url: null,
        title: null,
        stable: null,
        env_version: null,
        timings_ms: { load: null, settle: null, total: null },
    },
    macro: {
        macro_id: null,
        status: null,
        failed_step: null,
        repaired_macro_id: null,
        input_tokens: null,
        output_tokens: null,
    },
};

/**
 * Checks that `value` has exactly the fields of `shape`, recursively. Every
 * object field must be present (the Go side distinguishes nothing, but the
 * contract says every field is always sent); nested objects may be null
 * where Go has a pointer.
 */
function expectShape(value: unknown, shape: Shape, path = "$"): void {
    if (shape === null || value === null) return;
    if ("[]" in shape) {
        expect(Array.isArray(value), `${path} is an array`).toBe(true);
        (value as unknown[]).forEach((v, i) =>
            expectShape(v, (shape as { "[]": Shape })["[]"], `${path}[${i}]`),
        );
        return;
    }
    expect(typeof value, `${path} is an object`).toBe("object");
    const fields = shape as Record<string, Shape>;
    expect(Object.keys(value as object).sort(), `${path} fields`).toEqual(
        Object.keys(fields).sort(),
    );
    for (const [k, s] of Object.entries(fields)) {
        expectShape((value as Record<string, unknown>)[k], s, `${path}.${k}`);
    }
}

const pricingPage = html(
    `<header style="height:60px;background:#123;color:#fff">
       <nav><a href="/">Acme</a> <a href="/pricing">Pricing</a></nav>
     </header>
     <main style="padding:20px">
       <h1>Simple, transparent pricing</h1>
       <p class="lede">Choose the plan that fits your team.</p>
       <section class="plans" style="display:flex;gap:16px">
         <article class="plan" style="flex:1;border:1px solid #ccc;padding:12px">
           <h2>Starter</h2><p class="price"><span>$9</span> / month</p>
           <ul><li>1 project</li><li>Email support</li></ul>
         </article>
         <article class="plan" style="flex:1;border:1px solid #ccc;padding:12px">
           <h2>Pro</h2><p class="price"><span>$49</span> / month</p>
           <ul><li>10 projects</li><li>Priority support</li></ul>
         </article>
         <article class="plan" style="flex:1;border:1px solid #ccc;padding:12px">
           <h2>Team</h2><p class="price"><span>$99</span> / month</p>
           <ul><li>Unlimited projects</li><li>SSO</li></ul>
         </article>
       </section>
       <div class="updated" style="margin-top:12px">Prices updated 2026-09-28 12:00 UTC</div>
     </main>
     <footer><p>© 2026 Acme Inc.</p></footer>`,
    `<title>Pricing · Acme</title>
     <style>body{margin:0;font:16px/1.4 sans-serif} h1,h2,p,ul{margin:0 0 8px}</style>`,
);

let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
    server = await startServer({ "/pricing": pricingPage });
    pool = await launchPool();
});

afterAll(async () => {
    await pool?.close();
    await server?.close();
});

function handlerFor(published: Capture[], store = new MemoryStore()) {
    return createScrapeJobHandler({
        ...deps(pool, store),
        publishResult: async c => {
            // Round-trip through JSON: the shape on the wire is what counts.
            published.push(JSON.parse(JSON.stringify(c)) as Capture);
        },
    });
}

describe("scrape job handler", () => {
    it("publishes a Capture v3 with exactly the contract's fields", async () => {
        const published: Capture[] = [];
        const job = makeJob(`${server.origin}/pricing`, {
            viewport: { w: 1366, h: 768 },
            capture: { screenshot: "webp" },
        });
        await handlerFor(published).execute(job);

        expect(published).toHaveLength(1);
        const capture = published[0]!;
        expect(capture.status).toBe("ok");
        expectShape(capture, captureShape);
        expect(capture.blocks.map(b => b.text)).toContain("$49 / month");
        expect(capture.masks).toEqual([]);
        expect(capture.macro).toBeNull();
    });

    it("includes the Macro result in the contract shape", async () => {
        const published: Capture[] = [];
        const db = new FakeStore();
        db.addMonitor(MONITOR_ID, `${server.origin}/pricing`);
        const macro = db.addMacro(MONITOR_ID, [
            {
                type: "scroll",
                intent: "Scroll to the plans",
                selectors: ["css=.plans"],
            },
        ]);
        const store = new MemoryStore();
        await createScrapeJobHandler({
            ...deps(pool, store, {
                macros: createMacroRunner({
                    store: db,
                    objectStore: store,
                    repairer: null,
                }),
            }),
            publishResult: async c => {
                published.push(JSON.parse(JSON.stringify(c)) as Capture);
            },
        }).execute(makeJob(`${server.origin}/pricing`, { macro_id: macro.id }));

        const capture = published[0]!;
        expect(capture.status).toBe("ok");
        expect(capture.macro).toMatchObject({
            macro_id: macro.id,
            status: "ok",
        });
        expectShape(capture, captureShape);
    });

    it("produces the same fields as the scheduler's golden Capture", async () => {
        // The scheduler decodes Captures with unknown fields disallowed and
        // keeps its own example in its testdata. Comparing a Capture this
        // worker really produces with that file, key for key, means neither
        // side can add or drop a field without this failing.
        const fixture = JSON.parse(
            readFileSync(
                fileURLToPath(
                    new URL(
                        "../../../scheduler/internal/capture/testdata/capture-v3.json",
                        import.meta.url,
                    ),
                ),
                "utf8",
            ),
        ) as Capture;

        // It reads as a Capture v3 on this side.
        expect(fixture.version).toBe(3);
        expect(["ok", "invalid", "error"]).toContain(fixture.status);
        expect([
            null,
            "http_status",
            "challenge",
            "empty",
            "blank_screenshot",
            "cross_domain",
            "macro_failed",
        ]).toContain(fixture.invalid_reason);
        expect(fixture.macro).not.toBeNull();
        expect(fixture.screenshot).not.toBeNull();
        expect(fixture.blocks.length).toBeGreaterThan(0);
        expectShape(fixture, captureShape);

        const published: Capture[] = [];
        const db = new FakeStore();
        db.addMonitor(MONITOR_ID, `${server.origin}/pricing`);
        const macro = db.addMacro(MONITOR_ID, [
            { type: "wait", intent: "Wait a moment", ms: 1 },
        ]);
        const store = new MemoryStore();
        await createScrapeJobHandler({
            ...deps(pool, store, {
                macros: createMacroRunner({
                    store: db,
                    objectStore: store,
                    repairer: null,
                }),
            }),
            publishResult: async c => {
                published.push(JSON.parse(JSON.stringify(c)) as Capture);
            },
        }).execute(makeJob(`${server.origin}/pricing`, { macro_id: macro.id }));
        const mine = published[0]!;
        expect(mine.status).toBe("ok");

        const keys = (value: object | null | undefined) =>
            Object.keys(value ?? {}).sort();
        expect(keys(mine)).toEqual(keys(fixture));
        expect(keys(mine.meta)).toEqual(keys(fixture.meta));
        expect(keys(mine.meta.timings_ms)).toEqual(
            keys(fixture.meta.timings_ms),
        );
        expect(keys(mine.macro)).toEqual(keys(fixture.macro));
        expect(keys(mine.screenshot)).toEqual(keys(fixture.screenshot));
        expect(keys(mine.blocks[0])).toEqual(keys(fixture.blocks[0]));

        // The Capture published when nothing could be taken has them all too.
        const failed: Capture[] = [];
        await handlerFor(failed).reportFailure(
            makeJob(`${server.origin}/pricing`),
            new Error("boom"),
        );
        expect(keys(failed[0])).toEqual(keys(fixture));
        expect(keys(failed[0]!.meta)).toEqual(keys(fixture.meta));
    });

    it("publishes one error Capture when the page cannot be captured", async () => {
        const published: Capture[] = [];
        await handlerFor(published).execute(makeJob("http://127.0.0.1:1/down"));

        expect(published).toHaveLength(1);
        const capture = published[0]!;
        expectShape(capture, captureShape);
        expect(capture).toMatchObject({
            version: 3,
            run_id: RUN_ID,
            monitor_id: MONITOR_ID,
            status: "error",
            invalid_reason: null,
            blocks: [],
            screenshot: null,
            macro: null,
        });
        expect(capture.error?.message).toMatch(/^page\.goto: net::ERR_/);
        // Playwright's multi-line call log is not part of the message.
        expect(capture.error?.message).not.toContain("\n");
        expect(capture.meta.env_version).toBe("2026-11-21.1");
    });

    it("publishes an invalid Capture with its reason", async () => {
        const published: Capture[] = [];
        await handlerFor(published).execute(makeJob(`${server.origin}/nope`));
        expect(published[0]).toMatchObject({
            status: "invalid",
            invalid_reason: "http_status",
            error: null,
        });
        expectShape(published[0], captureShape);
    });

    it("reportFailure publishes an error Capture", async () => {
        const published: Capture[] = [];
        const job = makeJob(`${server.origin}/pricing`);
        await handlerFor(published).reportFailure(job, new Error("boom"));
        expect(published[0]).toMatchObject({
            status: "error",
            error: { message: "boom" },
        });
        expectShape(published[0], captureShape);
    });
});

describe("parseScrapeJob", () => {
    const valid = (): Record<string, unknown> =>
        JSON.parse(
            JSON.stringify(
                makeJob("https://example.com/pricing", {
                    storage_state_key: `state/${MONITOR_ID}.json`,
                    macro_id: "0b0f6a52-3c58-4d1e-9d5f-4f1f1b9f3a11",
                }),
            ),
        ) as Record<string, unknown>;

    const withField = (path: string[], value: unknown) => {
        const job = valid();
        let target: Record<string, unknown> = job;
        for (const key of path.slice(0, -1)) {
            target = target[key] as Record<string, unknown>;
        }
        if (value === undefined) delete target[path.at(-1)!];
        else target[path.at(-1)!] = value;
        return JSON.stringify(job);
    };

    it("accepts a valid job", () => {
        const job: ScrapeJob = parseScrapeJob(JSON.stringify(valid()));
        expect(job).toEqual(valid());
    });

    it("accepts a null storage_state_key and a null macro_id", () => {
        const job = valid();
        job.storage_state_key = null;
        job.macro_id = null;
        const parsed = parseScrapeJob(JSON.stringify(job));
        expect(parsed.storage_state_key).toBeNull();
        expect(parsed.macro_id).toBeNull();
    });

    it("drops fields a v3 job does not have", () => {
        const job = { ...valid(), scope: { kind: "page" } };
        expect(parseScrapeJob(JSON.stringify(job))).not.toHaveProperty("scope");
    });

    it.each<[string, string[], unknown]>([
        ["a non-object", [], undefined],
        ["a v2 job", ["version"], 2],
        ["a bad run_id", ["run_id"], "run-1"],
        ["a bad monitor_id", ["monitor_id"], "not-a-uuid"],
        ["a non-http url", ["url"], "file:///etc/passwd"],
        ["an unparseable url", ["url"], "not a url"],
        ["a missing macro_id", ["macro_id"], undefined],
        ["a macro_id that is not a UUID", ["macro_id"], "macro-1"],
        ["a fractional viewport", ["viewport", "w"], 12.5],
        ["an unknown screenshot format", ["capture", "screenshot"], "jpeg"],
        ["a missing full_page", ["capture", "full_page"], undefined],
        ["a negative extra wait", ["capture", "extra_wait_ms"], -1],
        ["a missing block_ads flag", ["capture", "block_ads"], undefined],
        ["a missing storage_state_key", ["storage_state_key"], undefined],
        [
            "another Monitor's storage state",
            ["storage_state_key"],
            "state/other.json",
        ],
        ["a missing env_version", ["env_version"], undefined],
    ])("rejects %s", (_name, path, value) => {
        const body = path.length === 0 ? "[]" : withField(path, value);
        expect(() => parseScrapeJob(body)).toThrow(/Invalid job format/);
    });
});
