import type { MacroStep } from "@watchthatsite/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMacroRunner } from "../macro/run.js";
import { FakeStore } from "../testing/fake-store.js";
import {
    deps,
    launchPool,
    makeJob,
    MemoryStore,
    MONITOR_ID,
    RUN_ID,
} from "../testing/harness.js";
import {
    SITE_EMAIL,
    SITE_PASSWORD,
    startAccountSite,
    type AccountSite,
} from "../testing/site.js";
import type { BrowserPool } from "./browser-pool.js";
import { takeCapture } from "./capture.js";
import { storageStateKey } from "./keys.js";

let site: AccountSite;
let pool: BrowserPool;
let db: FakeStore;
let objects: MemoryStore;

const signIn: MacroStep[] = [
    {
        type: "fill",
        intent: "Type the email",
        selectors: ["label=Email"],
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
const openBilling: MacroStep[] = [
    {
        type: "click",
        intent: "Open the Billing tab",
        selectors: ['role=tab[name="Billing"]', "css=#tab-billing"],
        timeout_ms: 2_000,
    },
    {
        type: "select",
        intent: "Switch to annual billing",
        selectors: ["label=Billing period"],
        value: "annual",
    },
];

beforeAll(async () => {
    site = await startAccountSite();
    pool = await launchPool();
});

afterAll(async () => {
    await pool?.close();
    await site?.close();
});

beforeEach(() => {
    site.state.renamed = false;
    db = new FakeStore();
    db.addMonitor(MONITOR_ID, `${site.origin}/app`);
    db.setSecret(MONITOR_ID, "password", SITE_PASSWORD);
    objects = new MemoryStore();
});

const run = (
    steps: MacroStep[],
    overrides: Parameters<typeof makeJob>[1] = {},
) => {
    const macro = db.addMacro(MONITOR_ID, steps);
    return takeCapture(
        deps(pool, objects, {
            macros: createMacroRunner({
                store: db,
                objectStore: objects,
                repairer: null,
            }),
        }),
        makeJob(`${site.origin}/app`, { macro_id: macro.id, ...overrides }),
    ).then(capture => ({ capture, macro }));
};

describe("takeCapture with a Macro", () => {
    it("replays the Macro and captures the page as the Macro left it", async () => {
        const { capture, macro } = await run([...signIn, ...openBilling], {
            storage_state_key: storageStateKey(MONITOR_ID),
        });

        expect(capture.status).toBe("ok");
        expect(capture.macro).toEqual({
            macro_id: macro.id,
            status: "ok",
            failed_step: null,
            repaired_macro_id: null,
            input_tokens: 0,
            output_tokens: 0,
        });
        // Signed in, the Billing tab open, the dropdown on Annual: the
        // state the steps built, not the page a fresh load would show.
        const texts = capture.blocks.map(b => b.text);
        expect(texts).toContain("Pro plan: $490 a year");
        expect(texts).not.toContain(`Welcome back, ${SITE_EMAIL}.`);
        expect(capture.meta.final_url).toBe(`${site.origin}/app`);
        expect(capture.meta.http_status).toBe(200);
        expect(capture.screenshot).not.toBeNull();

        // One trace row per step, each with a screenshot filed under the Run.
        const trace = db.trace(RUN_ID);
        expect(trace.map(s => [s.phase, s.kind, s.status, s.title])).toEqual([
            ["macro", "fill", "ok", "Type the email"],
            ["macro", "fill", "ok", "Type the password"],
            ["macro", "click", "ok", "Sign in"],
            ["macro", "click", "ok", "Open the Billing tab"],
            ["macro", "select", "ok", "Switch to annual billing"],
        ]);
        expect(trace.map(s => s.screenshotKey)).toEqual(
            [0, 1, 2, 3, 4].map(i => `steps/${MONITOR_ID}/${RUN_ID}/${i}.webp`),
        );
        expect(
            objects.objects.get(`steps/${MONITOR_ID}/${RUN_ID}/3.webp`)
                ?.contentType,
        ).toBe("image/webp");
        expect(trace[3]!.detail).toMatchObject({
            selector: 'role=tab[name="Billing"]',
        });

        // The secret went into the page and nowhere else.
        expect(JSON.stringify(capture)).not.toContain(SITE_PASSWORD);
        expect(JSON.stringify(db.steps)).not.toContain(SITE_PASSWORD);
        // The signed-in session is saved for the next Run.
        expect(objects.objects.has(storageStateKey(MONITOR_ID))).toBe(true);
    });

    it("skips the sign-in steps when the saved session is still valid", async () => {
        const key = storageStateKey(MONITOR_ID);
        await run([...signIn, ...openBilling], { storage_state_key: key });
        const signInsBefore = site.state.signIns;
        db.steps.length = 0;

        const { capture } = await run([...signIn, ...openBilling], {
            storage_state_key: key,
        });

        expect(capture.status).toBe("ok");
        expect(site.state.signIns).toBe(signInsBefore);
        expect(db.trace(RUN_ID).map(s => s.status)).toEqual([
            "skipped",
            "skipped",
            "skipped",
            "ok",
            "ok",
        ]);
        expect(capture.blocks.map(b => b.text)).toContain(
            "Pro plan: $490 a year",
        );
    });

    it("reports a Macro that cannot be completed as macro_failed, with a message a person can act on", async () => {
        site.state.renamed = true;
        const { capture, macro } = await run([...signIn, ...openBilling], {
            storage_state_key: storageStateKey(MONITOR_ID),
        });

        expect(capture.status).toBe("invalid");
        expect(capture.invalid_reason).toBe("macro_failed");
        expect(capture.error).toEqual({
            message:
                "Step 4 (Open the Billing tab) could not be completed: no element matched",
        });
        expect(capture.macro).toMatchObject({
            macro_id: macro.id,
            status: "failed",
            failed_step: 3,
        });
        expect(capture.screenshot).toBeNull();
        expect(capture.blocks).toEqual([]);
        expect(db.trace(RUN_ID).at(-1)).toMatchObject({
            status: "failed",
            kind: "click",
        });
        // An invalid Capture never updates the saved session.
        expect(objects.objects.has(storageStateKey(MONITOR_ID))).toBe(false);
    });

    it("lets a Macro end on another host", async () => {
        const { capture } = await run([
            ...signIn,
            {
                type: "navigate",
                intent: "Open the partner page",
                url: `${site.otherOrigin}/elsewhere`,
            },
        ]);
        // Without a Macro this would be `cross_domain`.
        expect(capture.status).toBe("ok");
        expect(capture.meta.final_url).toBe(`${site.otherOrigin}/elsewhere`);
    });

    it("fails the Macro when it no longer exists", async () => {
        const capture = await takeCapture(
            deps(pool, objects, {
                macros: createMacroRunner({
                    store: db,
                    objectStore: objects,
                    repairer: null,
                }),
            }),
            makeJob(`${site.origin}/login`, {
                macro_id: "11111111-2222-4333-8444-555555555555",
            }),
        );
        expect(capture.invalid_reason).toBe("macro_failed");
        expect(capture.macro).toMatchObject({
            status: "failed",
            failed_step: null,
        });
        expect(capture.error?.message).toMatch(/no longer exists/);
    });

    it("throws when the job names a Macro and replay is not configured", async () => {
        await expect(
            takeCapture(
                deps(pool, objects),
                makeJob(`${site.origin}/login`, {
                    macro_id: "11111111-2222-4333-8444-555555555555",
                }),
            ),
        ).rejects.toThrow(/Macro replay is not configured/);
    });
});
