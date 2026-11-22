import type { MacroStep } from "@watchthatsite/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserPool } from "../lib/browser-pool.js";
import { takeCapture } from "../lib/capture.js";
import { createMacroRunner, type Repairer } from "../macro/run.js";
import { closeDb, createFixture, hasDb, type Fixture } from "../testing/db.js";
import { FakeProvider, refOf } from "../testing/fake-provider.js";
import { FakeStore } from "../testing/fake-store.js";
import {
    deps,
    launchPool,
    makeJob,
    MemoryStore,
    MONITOR_ID,
    RUN_ID,
    silentLogger,
} from "../testing/harness.js";
import {
    SITE_EMAIL,
    SITE_PASSWORD,
    startAccountSite,
    type AccountSite,
} from "../testing/site.js";
import { createRepairer } from "./repair.js";

const signIn: MacroStep[] = [
    {
        type: "fill",
        intent: "Type the email",
        selectors: ['label="Email"'],
        value: SITE_EMAIL,
        optional: true,
        timeout_ms: 600,
    },
    {
        type: "fill",
        intent: "Type the password",
        selectors: ['label="Password"'],
        value: "{{secret:password}}",
        optional: true,
        timeout_ms: 600,
    },
    {
        type: "click",
        intent: "Sign in",
        selectors: ['role=button[name="Sign in"]'],
        optional: true,
        timeout_ms: 600,
    },
];
const billing: MacroStep[] = [
    {
        type: "click",
        intent: "Open the Billing tab",
        selectors: ['role=tab[name="Billing"]', "css=#tab-billing"],
        timeout_ms: 800,
    },
    {
        type: "select",
        intent: "Switch to annual billing",
        selectors: ['label="Billing period"'],
        value: "annual",
    },
];

let site: AccountSite;
let pool: BrowserPool;
let provider: FakeProvider;

beforeAll(async () => {
    site = await startAccountSite();
    pool = await launchPool();
    provider = await FakeProvider.start();
});

afterAll(async () => {
    await pool?.close();
    await provider?.close();
    await site?.close();
    await closeDb();
});

describe.skipIf(!hasDb)("repairing a Macro step during a Run", () => {
    let fx: Fixture;
    let objects: MemoryStore;
    let macroId: string;
    let runId: string;

    beforeEach(async () => {
        site.state.renamed = true;
        provider.reset();
        objects = new MemoryStore();
        fx = await createFixture({
            url: `${site.origin}/app`,
            gatewayUrl: provider.gatewayUrl,
            connection: {
                kind: "openai",
                model: "test-model",
            },
        });
        await fx.addSecret("password", SITE_PASSWORD);
        macroId = await fx.addMacro(
            [...signIn, ...billing],
            "active",
            "Sign in, open Billing, switch to Annual",
        );
        runId = await fx.addRun();
        return () => fx.cleanup();
    });

    const capture = (macro = macroId, run = runId) => {
        const agent = {
            store: fx.store,
            objectStore: objects,
            logger: silentLogger,
        };
        return takeCapture(
            deps(pool, objects, {
                macros: createMacroRunner({
                    store: fx.store,
                    objectStore: objects,
                    repairer: createRepairer(agent),
                }),
            }),
            makeJob(`${site.origin}/app`, {
                monitor_id: fx.monitorId,
                run_id: run,
                macro_id: macro,
            }),
        );
    };

    it("has the Agent complete the broken step, carries on, and saves a new active version", async () => {
        provider.queue(
            r => ({
                calls: [
                    {
                        name: "click",
                        input: {
                            ref: refOf(r, /tab "Plans & billing"/),
                            intent: "Open the plans and billing tab",
                        },
                    },
                ],
                usage: { input: 1500, output: 40 },
            }),
            {
                calls: [
                    {
                        name: "done",
                        input: {
                            what_changed:
                                "the Billing tab is now called 'Plans & billing'",
                        },
                    },
                ],
                usage: { input: 1700, output: 25 },
            },
        );
        const result = await capture();

        // The Capture stands: the later step ran on the page the repair left.
        expect(result.status).toBe("ok");
        expect(result.blocks.map(b => b.text)).toContain(
            "Pro plan: $490 a year",
        );
        expect(result.macro).toEqual({
            macro_id: macroId,
            status: "repaired",
            failed_step: null,
            repaired_macro_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            input_tokens: 3200,
            output_tokens: 65,
        });

        // One transaction: the old version archived, the repaired one active.
        const repaired = (await fx.store.getMacro(
            result.macro!.repaired_macro_id!,
        ))!;
        expect(repaired).toMatchObject({
            status: "active",
            source: "repair",
            version: 2,
            goal: "Sign in, open Billing, switch to Annual",
            note: "Step 4 'Open the Billing tab': the Billing tab is now called 'Plans & billing'",
        });
        expect((await fx.store.getMacro(macroId))?.status).toBe("archived");
        // The step keeps the owner's wording and gets selectors read off the element.
        expect(repaired.steps).toHaveLength(5);
        expect(repaired.steps[3]).toEqual({
            type: "click",
            intent: "Open the Billing tab",
            selectors: [
                'role=tab[name="Plans & billing"]',
                'text="Plans & billing"',
                "css=#tab-plans",
                "xpath=/html[1]/body[1]/nav[1]/div[1]/button[2]",
            ],
        });
        expect(repaired.steps[4]).toEqual(billing[1]);

        // What the model was shown: the failed step, its old selectors as page data, the page; no secret.
        const first = provider.requests[0]!;
        expect(first.lastText).toContain(
            "The Macro's goal, in the owner's words: \"Sign in, open Billing, switch to Annual\"",
        );
        expect(first.lastText).toContain(
            "> 4. Open the Billing tab (click; FAILED: no element matched)",
        );
        expect(first.lastText).toContain(
            "  5. Switch to annual billing (select; not reached yet)",
        );
        expect(first.lastText).toMatch(
            /<page-data-[0-9a-f]{8} what="selectors">\nrole=tab\[name="Billing"\]\ncss=#tab-billing\n<\/page-data-/,
        );
        expect(provider.requests.map(r => r.raw).join("\n")).not.toContain(
            SITE_PASSWORD,
        );

        // The trace reads in order: the step, what the repair did, then the rest.
        const rows =
            await fx.sql`SELECT seq, phase, kind, status, title, screenshot_key, input_tokens FROM run_steps WHERE run_id = ${runId} ORDER BY seq`;
        expect(
            rows.map(r => [
                r.seq,
                r.phase,
                r.kind,
                r.status,
                r.title,
                r.inputTokens,
            ]),
        ).toEqual([
            [0, "macro", "fill", "ok", "Type the email", 0],
            [1, "macro", "fill", "ok", "Type the password", 0],
            [2, "macro", "click", "ok", "Sign in", 0],
            [3, "macro", "click", "repaired", "Open the Billing tab", 0],
            [
                4,
                "repair",
                "click",
                "ok",
                "Open the plans and billing tab",
                1500,
            ],
            [
                5,
                "repair",
                "done",
                "ok",
                "Repaired step 4: the Billing tab is now called 'Plans & billing'",
                1700,
            ],
            [6, "macro", "select", "ok", "Switch to annual billing", 0],
        ]);
        expect(rows[4]!.screenshotKey).toBe(
            `steps/${fx.monitorId}/${runId}/4.webp`,
        );
        expect(JSON.stringify(rows)).not.toContain(SITE_PASSWORD);

        // The next Run replays the repaired version with no model at all.
        const calls = provider.requests.length;
        const next = await capture(repaired.id, await fx.addRun());
        expect(next.macro).toMatchObject({
            macro_id: repaired.id,
            status: "ok",
            input_tokens: 0,
        });
        expect(next.blocks.map(b => b.text)).toContain("Pro plan: $490 a year");
        expect(provider.requests).toHaveLength(calls);
    });

    it("fails the Run with the Agent's reason when the step cannot be completed", async () => {
        provider.queue({
            calls: [
                {
                    name: "fail",
                    input: {
                        reason: "there is no billing section on this account any more",
                    },
                },
            ],
            usage: { input: 1400, output: 30 },
        });
        const result = await capture();

        expect(result.status).toBe("invalid");
        expect(result.invalid_reason).toBe("macro_failed");
        expect(result.error?.message).toBe(
            "Step 4 (Open the Billing tab) could not be completed: no element matched. It could not be repaired: there is no billing section on this account any more",
        );
        expect(result.macro).toMatchObject({
            status: "failed",
            failed_step: 3,
            repaired_macro_id: null,
            input_tokens: 1400,
            output_tokens: 30,
        });
        // Nothing was saved.
        expect((await fx.store.getMacro(macroId))?.status).toBe("active");
        expect(
            await fx.sql`SELECT id FROM macros WHERE monitor_id = ${fx.monitorId}`,
        ).toHaveLength(1);
        const rows =
            await fx.sql`SELECT phase, kind, status FROM run_steps WHERE run_id = ${runId} ORDER BY seq`;
        expect(rows.slice(3).map(r => [r.phase, r.kind, r.status])).toEqual([
            ["macro", "click", "failed"],
            ["repair", "fail", "failed"],
        ]);
    });

    it("does not let the Agent finish a repair without acting", async () => {
        provider.queue(
            { calls: [{ name: "done", input: { what_changed: "nothing" } }] },
            { calls: [{ name: "fail", input: { reason: "the tab is gone" } }] },
        );
        const result = await capture();
        expect(provider.requests[1]!.lastText).toContain(
            "You have not taken an action yet",
        );
        expect(result.invalid_reason).toBe("macro_failed");
    });

    it("fails with macro_failed when the Monitor has no usable connection", async () => {
        await fx.sql`UPDATE provider_connections SET enabled = FALSE WHERE id = ${fx.connectionId}`;
        const result = await capture();
        expect(result.invalid_reason).toBe("macro_failed");
        expect(result.error?.message).toBe(
            "Step 4 (Open the Billing tab) could not be completed: no element matched. It could not be repaired because the Monitor has no usable model connection.",
        );
        expect(result.macro).toMatchObject({
            status: "failed",
            failed_step: 3,
            input_tokens: 0,
        });
        expect(provider.requests).toHaveLength(0);
    });

    it("fails with macro_failed when the model call fails", async () => {
        provider.queue({ error: { status: 401, message: "bad key" } });
        const result = await capture();
        expect(result.invalid_reason).toBe("macro_failed");
        expect(result.error?.message).toMatch(
            /It could not be repaired because the model call failed: The provider rejected the API key/,
        );
    });
});

describe("the limit on repairs", () => {
    it("repairs at most three steps in one Run", async () => {
        site.state.renamed = false;
        const db = new FakeStore();
        const objects = new MemoryStore();
        db.addMonitor(MONITOR_ID, `${site.origin}/login`);
        const broken = (n: number): MacroStep => ({
            type: "click",
            intent: `Click thing ${n}`,
            selectors: [`css=#missing-${n}`],
            timeout_ms: 200,
        });
        const macro = db.addMacro(MONITOR_ID, [
            broken(1),
            broken(2),
            broken(3),
            broken(4),
        ]);
        let asked = 0;
        const repairer: Repairer = {
            async repair() {
                asked++;
                return {
                    ok: true,
                    steps: [{ type: "wait", intent: "Wait a moment", ms: 1 }],
                    note: "replaced",
                    error: "",
                    inputTokens: 10,
                    outputTokens: 1,
                };
            },
        };
        const result = await takeCapture(
            deps(pool, objects, {
                macros: createMacroRunner({
                    store: db,
                    objectStore: objects,
                    repairer,
                }),
            }),
            makeJob(`${site.origin}/login`, { macro_id: macro.id }),
        );

        expect(asked).toBe(3);
        expect(result.invalid_reason).toBe("macro_failed");
        expect(result.macro).toMatchObject({
            status: "failed",
            failed_step: 3,
            input_tokens: 30,
            output_tokens: 3,
        });
        expect(result.error?.message).toBe(
            "Step 4 (Click thing 4) could not be completed: no element matched. It was not repaired: 3 steps of pre-scraping were already repaired in this Run, so it needs recording again.",
        );
        // A Macro that did not complete is not saved as repaired.
        expect(db.macros.size).toBe(1);
        expect(
            db
                .trace(RUN_ID)
                .filter(s => s.phase === "macro")
                .map(s => s.status),
        ).toEqual(["repaired", "repaired", "repaired", "failed"]);
    });
});
