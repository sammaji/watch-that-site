/**
 * One test per agent job against a real model. Opt in with REAL_MODEL=1; the
 * key comes from TEST_OPENAI_API_KEY (see vitest.config.ts) and is only ever
 * sent to api.openai.com. REAL_MODEL_NAME picks the model.
 *
 * These check that the answer is sensible, not that it is word for word what
 * we would write; each logs what the model returned and what it cost.
 */
import {
    howFor,
    sectionFor,
    type Block,
    type CompareRequest,
    type MacroStep,
    type PlanRequest,
    type RunRef,
    type TextOp,
    type WatchPlan,
} from "@watchthatsite/types";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserPool } from "../lib/browser-pool.js";
import { takeCapture } from "../lib/capture.js";
import { createMacroRunner } from "../macro/run.js";
import type { ResolvedConnection } from "../store/store.js";
import { FakeStore } from "../testing/fake-store.js";
import {
    deps,
    html,
    launchPool,
    makeJob,
    MemoryStore,
    MONITOR_ID,
    noBlockers,
    silentLogger,
    startServer,
    type FixtureServer,
} from "../testing/harness.js";
import {
    SITE_EMAIL,
    SITE_PASSWORD,
    startAccountSite,
    type AccountSite,
} from "../testing/site.js";
import { compare } from "./compare.js";
import { plan } from "./plan.js";
import { Recorder } from "./record.js";
import { createRepairer } from "./repair.js";

const key = process.env.TEST_OPENAI_API_KEY ?? "";
const enabled = process.env.REAL_MODEL === "1" && key !== "";
const model = process.env.REAL_MODEL_NAME || "gpt-5.4-mini";

const connection: ResolvedConnection = {
    id: "real",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: key,
    model,
};

const pixel = (color: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="${color}"/></svg>`)}`;

/** A marketing page with clear parts: a hero with a picture, a pricing table, rotating testimonials, a footer. */
const marketingPage = (v: {
    enterprise: string;
    quote: string;
    hero: string;
}) =>
    html(
        `<header style="padding:12px 24px;background:#111;color:#fff"><strong>Acme</strong></header>
         <main>
           <section id="hero" style="display:flex;gap:24px;padding:24px;align-items:center">
             <div style="flex:1"><h1>Ship faster with Acme</h1><p>The deployment platform for busy teams.</p></div>
             <img alt="Product photo" src="${pixel(v.hero)}" style="width:360px;height:220px;border-radius:8px">
           </section>
           <section id="pricing" style="padding:24px">
             <h2>Pricing</h2>
             <table style="border-collapse:collapse;width:100%">
               <tr><th style="text-align:left">Plan</th><th style="text-align:left">Price</th><th style="text-align:left">Includes</th></tr>
               <tr><td>Starter</td><td>$9 a month</td><td>1 project</td></tr>
               <tr><td>Pro</td><td>$49 a month</td><td>10 projects</td></tr>
               <tr><td>Enterprise</td><td>${v.enterprise} a month</td><td>Unlimited projects, SSO</td></tr>
             </table>
           </section>
           <section id="testimonials" class="carousel" style="padding:24px;background:#f4f4f4">
             <h2>What customers say</h2>
             <blockquote>${v.quote}</blockquote>
           </section>
         </main>
         <footer style="padding:24px"><p>© 2026 Acme Inc. Last updated 21 November 2026.</p></footer>`,
        `<title>Acme pricing</title><style>body{margin:0;font:16px/1.5 sans-serif} h1,h2,p{margin:0 0 8px} td,th{padding:6px 8px;border-bottom:1px solid #ddd}</style>`,
    );

describe.skipIf(!enabled)(`the Agent on a real model (${model})`, () => {
    let pool: BrowserPool;
    let pages: FixtureServer;
    let site: AccountSite;
    let objects: MemoryStore;

    beforeAll(async () => {
        pool = await launchPool(4);
        site = await startAccountSite();
        pages = await startServer({
            "/before": marketingPage({
                enterprise: "$99",
                quote: "“Acme halved our release time.” — Dana, Initech",
                hero: "#2f6fde",
            }),
            "/after": marketingPage({
                enterprise: "$129",
                quote: "“We deploy ten times a day now.” — Sam, Globex",
                hero: "#2f6fde",
            }),
        });
        objects = new MemoryStore();
    });

    afterAll(async () => {
        await pool?.close();
        await pages?.close();
        await site?.close();
    });

    /** Takes a real Capture of a fixture page and stores its blocks the way the scheduler does. */
    async function capturePage(
        path: string,
    ): Promise<{ ref: RunRef; blocks: Block[]; size: [number, number] }> {
        const runId = randomUUID();
        const capture = await takeCapture(
            deps(pool, objects),
            makeJob(`${pages.origin}${path}`, {
                run_id: runId,
                viewport: { w: 1000, h: 700 },
            }),
        );
        expect(capture.status).toBe("ok");
        const blocksKey = `captures/${MONITOR_ID}/${runId}/blocks.json.gz`;
        await objects.putObject(
            blocksKey,
            gzipSync(
                JSON.stringify({
                    version: 1,
                    blocks: capture.blocks,
                    truncated: false,
                }),
            ),
        );
        return {
            ref: {
                run_id: runId,
                at: new Date().toISOString(),
                screenshot: capture.screenshot!.key,
                blocks: blocksKey,
            },
            blocks: capture.blocks,
            size: [capture.screenshot!.w, capture.screenshot!.h],
        };
    }

    const storeWith = () => {
        const db = new FakeStore();
        db.connection = connection;
        return db;
    };

    const spent = (db: FakeStore, subject: string) => ({
        rows: db
            .trace(subject)
            .map(s => `${s.phase}/${s.kind} [${s.status}] ${s.title}`),
        input_tokens: db.trace(subject).reduce((n, s) => n + s.inputTokens, 0),
        output_tokens: db
            .trace(subject)
            .reduce((n, s) => n + s.outputTokens, 0),
    });

    it("plan: divides a page with clear parts sensibly", async () => {
        const db = storeWith();
        const captured = await capturePage("/before");
        const request: PlanRequest = {
            run_id: captured.ref.run_id,
            monitor_id: MONITOR_ID,
            user_id: "user-1",
            monitor: {
                name: "Acme pricing",
                url: "https://acme.example/pricing",
                instructions:
                    "Tell me when a price or what a plan includes changes, and when the hero image gets a new look. Ignore the customer testimonials.",
            },
            connection_id: null,
            model: null,
            capture: captured.ref,
            size: captured.size,
            previous: null,
            load: null,
        };
        const response = await plan(
            { store: db, objectStore: objects, logger: silentLogger },
            request,
        );
        console.log(
            "PLAN",
            JSON.stringify(
                { ...response, trace: spent(db, captured.ref.run_id).rows },
                null,
                2,
            ),
        );

        const made: WatchPlan = {
            version: 1,
            ...response,
            instructions_hash: "",
            run_id: captured.ref.run_id,
            created_at: "",
        };
        const find = (test: (b: Block) => boolean) =>
            captured.blocks.find(test)!;
        const price = find(b => b.text.includes("$99"));
        const photo = find(b => b.tag === "img");
        const quote = find(b => b.tag === "blockquote");
        expect(photo, "the hero image is a block").toBeDefined();

        // Prices are watched for their words, the hero image for its look, testimonials not at all.
        expect(["text", "both"]).toContain(howFor(made, price.path));
        expect(["visual", "both"]).toContain(howFor(made, photo.path));
        expect(howFor(made, quote.path)).toBe("ignore");
        expect(sectionFor(made, price.path)?.id).not.toBe(
            sectionFor(made, quote.path)?.id,
        );
        expect(response.sections.length).toBeGreaterThanOrEqual(2);
        expect(response.sections.length).toBeLessThanOrEqual(10);
        expect(response.summary.length).toBeGreaterThan(20);
        expect(response.input_tokens).toBeGreaterThan(0);
    });

    it("compare: reports the price change and leaves the testimonial out", async () => {
        const db = storeWith();
        const before = await capturePage("/before");
        const after = await capturePage("/after");
        const at = (blocks: Block[], test: (b: Block) => boolean) =>
            blocks.find(test)!;
        const oldPrice = at(before.blocks, b => b.text === "$99 a month");
        const newPrice = at(after.blocks, b => b.text === "$129 a month");
        const oldQuote = at(before.blocks, b => b.tag === "blockquote");
        const newQuote = at(after.blocks, b => b.tag === "blockquote");

        // The diff the scheduler would have made, written by hand.
        const ops: TextOp[] = [
            {
                op: "modify",
                path: newPrice.path,
                tag: "td",
                block_id: newPrice.id,
                from_block_id: oldPrice.id,
                from: 0,
                to: 0,
                rect: newPrice.rect,
                from_rect: oldPrice.rect,
                old_text: oldPrice.text,
                text: newPrice.text,
                tokens: [
                    { op: "-", text: "$99" },
                    { op: "+", text: "$129" },
                    { op: "=", text: "a month" },
                ],
                context_before: ["Enterprise"],
                context_after: ["Unlimited projects, SSO"],
            },
            {
                op: "modify",
                path: newQuote.path,
                tag: "blockquote",
                block_id: newQuote.id,
                from_block_id: oldQuote.id,
                from: 1,
                to: 1,
                old_text: oldQuote.text,
                text: newQuote.text,
                whole: true,
            },
        ];
        const request: CompareRequest = {
            run_id: after.ref.run_id,
            monitor_id: MONITOR_ID,
            user_id: "user-1",
            monitor: {
                name: "Acme pricing",
                url: "https://acme.example/pricing",
                instructions:
                    "Tell me when a price changes. Ignore the customer testimonials.",
            },
            connection_id: null,
            model: null,
            from: before.ref,
            to: after.ref,
            text: { ops, ignored_count: 0, masked: [] },
            regions: [
                {
                    box: newPrice.rect,
                    from_box: newPrice.rect,
                    kind: "changed",
                    pixels: 900,
                    section: "",
                },
                {
                    box: newQuote.rect,
                    from_box: newQuote.rect,
                    kind: "changed",
                    pixels: 5200,
                    section: "",
                },
            ],
            plan: null,
            size_before: before.size,
            size_after: after.size,
            feedback: [
                {
                    summary: "Only the rotating testimonial changed.",
                    feedback: "noise",
                },
            ],
        };
        const response = await compare(
            { store: db, objectStore: objects, logger: silentLogger },
            request,
        );
        console.log(
            "COMPARE",
            JSON.stringify(
                { ...response, trace: spent(db, after.ref.run_id).rows },
                null,
                2,
            ),
        );

        expect(response.relevant).toBe(true);
        expect(response.summary).toMatch(/\$129/);
        expect(response.summary).toMatch(/\$99/);
        expect(response.items.length).toBeGreaterThanOrEqual(1);
        // The price item cites the price evidence, and nothing reports the testimonial as a change.
        expect(
            response.items.some(
                i => i.ops.includes(0) || i.regions.includes(0),
            ),
        ).toBe(true);
        expect(
            response.items.every(
                i =>
                    !/halved|ten times|testimonial/i.test(
                        `${i.title} ${i.after}`,
                    ),
            ),
        ).toBe(true);
        expect(
            response.ignored.some(i =>
                /testimonial|quote|customer/i.test(`${i.note} ${i.reason}`),
            ),
        ).toBe(true);
        expect(response.input_tokens).toBeGreaterThan(0);
        expect(response.output_tokens).toBeGreaterThan(0);
    });

    it("record: signs in and opens Billing on the fixture site, and the Macro replays", async () => {
        const db = storeWith();
        const monitorId = randomUUID();
        db.addMonitor(monitorId, `${site.origin}/app`, {
            name: "Acme billing",
        });
        db.setSecret(monitorId, "password", SITE_PASSWORD);
        site.state.renamed = false;
        const recorder = new Recorder({
            store: db,
            objectStore: objects,
            logger: silentLogger,
            pool,
            blockers: noBlockers,
        });

        const macroId = await recorder.start({
            monitor_id: monitorId,
            goal: `Sign in as ${SITE_EMAIL} with the stored password, open the Billing tab and switch the billing period to Annual.`,
        });
        const deadline = Date.now() + 280_000;
        while (
            db.macros.get(macroId)!.status === "recording" &&
            Date.now() < deadline
        ) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        await recorder.close();
        const macro = db.macros.get(macroId)!;
        console.log(
            "RECORD",
            JSON.stringify(
                {
                    status: macro.status,
                    note: macro.note,
                    steps: macro.steps,
                    ...spent(db, macroId),
                },
                null,
                2,
            ),
        );

        expect(macro.status).toBe("draft");
        const fills = macro.steps.filter(
            (s): s is Extract<MacroStep, { type: "fill" }> => s.type === "fill",
        );
        expect(fills.some(s => s.value === "{{secret:password}}")).toBe(true);
        expect(fills.some(s => s.value === SITE_EMAIL)).toBe(true);
        expect(macro.steps.some(s => s.type === "select")).toBe(true);
        expect(
            macro.steps.every(
                s => !("selectors" in s) || (s.selectors ?? []).length > 0,
            ),
        ).toBe(true);
        expect(JSON.stringify(macro)).not.toContain(SITE_PASSWORD);
        expect(JSON.stringify(db.steps)).not.toContain(SITE_PASSWORD);
        expect(db.trace(macroId).at(-1)).toMatchObject({
            kind: "verify",
            status: "ok",
        });
    }, 300_000);

    it("repair: completes a step whose selector was broken on purpose", async () => {
        const db = storeWith();
        const monitorId = randomUUID();
        const runId = randomUUID();
        db.addMonitor(monitorId, `${site.origin}/app`);
        db.setSecret(monitorId, "password", SITE_PASSWORD);
        // Recorded against the old page: the tab was called "Billing".
        site.state.renamed = true;
        const macro = db.addMacro(
            monitorId,
            [
                {
                    type: "fill",
                    intent: "Type the account email",
                    selectors: ['label="Email"'],
                    value: SITE_EMAIL,
                    optional: true,
                    timeout_ms: 3000,
                },
                {
                    type: "fill",
                    intent: "Type the password",
                    selectors: ['label="Password"'],
                    value: "{{secret:password}}",
                    optional: true,
                    timeout_ms: 3000,
                },
                {
                    type: "click",
                    intent: "Sign in",
                    selectors: ['role=button[name="Sign in"]'],
                    optional: true,
                    timeout_ms: 3000,
                },
                {
                    type: "click",
                    intent: "Open the Billing tab",
                    selectors: [
                        'role=tab[name="Billing"]',
                        "data-testid=billing-tab",
                        "css=#tab-billing",
                    ],
                    timeout_ms: 2000,
                },
                {
                    type: "select",
                    intent: "Switch to annual billing",
                    selectors: ['label="Billing period"'],
                    value: "annual",
                },
            ],
            "Sign in, open the Billing tab and switch the billing period to Annual",
        );
        const agent = { store: db, objectStore: objects, logger: silentLogger };
        const capture = await takeCapture(
            deps(pool, objects, {
                macros: createMacroRunner({
                    store: db,
                    objectStore: objects,
                    repairer: createRepairer(agent),
                }),
            }),
            makeJob(`${site.origin}/app`, {
                monitor_id: monitorId,
                run_id: runId,
                macro_id: macro.id,
            }),
        );
        site.state.renamed = false;
        const repaired =
            capture.macro?.repaired_macro_id ?
                db.macros.get(capture.macro.repaired_macro_id)
            :   null;
        console.log(
            "REPAIR",
            JSON.stringify(
                {
                    status: capture.status,
                    error: capture.error,
                    macro: capture.macro,
                    note: repaired?.note,
                    step: repaired?.steps[3],
                    trace: spent(db, runId).rows,
                },
                null,
                2,
            ),
        );

        expect(capture.status).toBe("ok");
        expect(capture.macro).toMatchObject({ status: "repaired" });
        expect(capture.macro!.input_tokens).toBeGreaterThan(0);
        expect(capture.blocks.map(b => b.text)).toContain(
            "Pro plan: $490 a year",
        );
        expect(repaired).toMatchObject({ status: "active", source: "repair" });
        expect(repaired!.steps).toHaveLength(5);
        expect(
            (repaired!.steps[3] as { selectors: string[] }).selectors[0],
        ).toBe('role=tab[name="Plans & billing"]');
        expect(db.macros.get(macro.id)!.status).toBe("archived");
    }, 300_000);
});
