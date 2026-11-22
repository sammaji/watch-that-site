/**
 * End to end, against the running stack and a real model.
 *
 * Two stories, each a sequence of Runs on one Monitor:
 *
 *   storefront  a public page with a hero image, plan prices and a testimonial
 *               that rotates on every load. Covers the Watch Plan, Noise that
 *               never reaches the model, a visual Change, a text Change, and
 *               the webhook Reaction.
 *   account     a price behind a sign-in, a tab and a toggle. Covers recording
 *               a Macro with the agent, replaying it with a saved session, a
 *               Change found behind it, and repairing a step after the site
 *               renames a tab.
 *
 * The model's wording varies, so assertions check facts ("mentions 129",
 * "cites evidence", "the testimonial Section is ignored"), not sentences.
 *
 * Needs the stack (see lib.ts `requireStack`) and TEST_OPENAI_API_KEY; skipped
 * without the key. Costs a few cents per run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
    Macro,
    Monitor,
    ProviderConnection,
    WatchPlan,
} from "../../packages/types/src/index";
import {
    closeDb,
    createTestUser,
    deleteTestUser,
    type TestUser,
} from "../lib/users";
import {
    approveMacro,
    changeOf,
    config,
    createConnection,
    createMonitor,
    createWebhookChannel,
    fetchObject,
    getMonitor,
    macrosOf,
    putMonitorSecret,
    recordMacro,
    recordOf,
    requireStack,
    runAndWait,
    runSteps,
    setVariant,
    sinkRequests,
} from "./lib";

const RUN = 300_000;

/** Prints what the model said, so a failing assertion can be judged by a person. */
function note(label: string, value: unknown) {
    console.log(
        `\n[e2e] ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`,
    );
}

describe.skipIf(!config.openaiKey)("agentic end to end", () => {
    let user: TestUser;
    let connection: ProviderConnection;

    beforeAll(async () => {
        await requireStack();
        user = await createTestUser("agentic");
        connection = await createConnection(user);
        note("connection", {
            kind: connection.kind,
            models: connection.models.length,
            default_model: connection.default_model,
            using: config.model,
        });
    }, 60_000);

    afterAll(async () => {
        if (!process.env.E2E_KEEP_USER) await deleteTestUser(user);
        else note("kept user", { email: user.email, password: user.password });
        await closeDb();
    });

    it("stores the model key encrypted and lists models", () => {
        expect(connection.models.length).toBeGreaterThan(0);
        expect(connection.models).toContain(config.model);
        expect(JSON.stringify(connection)).not.toContain(config.openaiKey);
    });

    describe("storefront: Watch Plan, Noise, visual and text Changes", () => {
        let monitor: Monitor;
        let webhook: string;
        let plan: WatchPlan;

        beforeAll(async () => {
            await setVariant("storefront", "v1");
            webhook = await createWebhookChannel(user);
            monitor = await createMonitor(user, {
                name: "Northwind storefront",
                url: "diff/storefront",
                instructions:
                    "Tell me when the price of a plan changes, or when the hero image is replaced. Ignore the customer testimonials.",
                connection_id: connection.id,
            });
        });

        it(
            "takes a Baseline and plans how to watch the page",
            async () => {
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("baseline run", run);
                expect(run.status).toBe("succeeded");
                expect(run.verdict).toBe("baseline");
                expect(run.input_tokens).toBeGreaterThan(0);

                const saved = (await getMonitor(user, monitor.id)).watch_plan;
                expect(saved).not.toBeNull();
                plan = saved!;
                note("watch plan", {
                    summary: plan.summary,
                    rest: plan.rest,
                    sections: plan.sections.map(
                        s =>
                            `${s.name}: ${s.how} (${s.paths.join(", ")}) — ${s.why}`,
                    ),
                });

                const how = (pattern: RegExp) =>
                    plan.sections.find(s => pattern.test(`${s.name} ${s.id}`))
                        ?.how;
                expect(how(/testimonial|customer|quote/i)).toBe("ignore");
                expect(["visual", "both"]).toContain(how(/hero|image|banner/i));
                expect(["text", "both"]).toContain(how(/plan|pric/i));

                const steps = await runSteps(user, run.run_id);
                expect(steps.some(s => s.phase === "plan")).toBe(true);
            },
            RUN,
        );

        it(
            "does not call the model when only the ignored testimonial changed",
            async () => {
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("noise run", run);
                expect(run.status).toBe("succeeded");
                expect(["none", "noise"]).toContain(run.verdict);
                expect(run.input_tokens).toBe(0);
                const change = await changeOf(user, run.run_id);
                if (change) {
                    expect(change.status).toBe("noise");
                    expect(change.suppressed_by).toContain("ignored_section");
                    expect(change.notified_at).toBeNull();
                }
            },
            RUN,
        );

        it(
            "reports a replaced hero image as a visual Change",
            async () => {
                await setVariant("storefront", "v3");
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("hero run", run);
                expect(run.status).toBe("succeeded");
                expect(run.verdict).toBe("change");

                const change = (await changeOf(user, run.run_id))!;
                const record = await recordOf(user, change);
                note("hero change", {
                    summary: record.summary,
                    items: record.items,
                    ignored: record.ignored,
                    regions: record.visual?.regions.length,
                    agent: record.agent,
                });
                expect(record.version).toBe(2);
                expect(record.agent?.relevant).toBe(true);
                expect(record.agent?.unavailable).toBe(false);
                expect(record.visual?.regions.length ?? 0).toBeGreaterThan(0);
                expect(record.items.length).toBeGreaterThan(0);
                const visual = record.items.find(i => i.regions.length > 0);
                expect(
                    visual,
                    "an item that cites a changed region",
                ).toBeDefined();
                expect(visual!.rect_after).not.toBeNull();
                expect(record.summary).toMatch(
                    /hero|image|illustration|picture|banner|graphic/i,
                );
                // The price did not change, so no item should claim it did.
                expect(JSON.stringify(record.items)).not.toMatch(/\$129/);
            },
            RUN,
        );

        it(
            "reports a price rise as a text Change and sends the webhook",
            async () => {
                // v2 also puts the first hero image back.
                await setVariant("storefront", "v2");
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("price run", run);
                expect(run.status).toBe("succeeded");
                expect(run.verdict).toBe("change");
                expect(run.summary ?? "").toMatch(/129/);

                const change = (await changeOf(user, run.run_id))!;
                const record = await recordOf(user, change);
                note("price change", {
                    summary: record.summary,
                    items: record.items,
                    ignored: record.ignored,
                });
                const price = record.items.find(i => /129/.test(i.after));
                expect(
                    price,
                    "an item whose `after` quotes the new price",
                ).toBeDefined();
                expect(price!.before).toMatch(/99/);
                expect(price!.ops.length).toBeGreaterThan(0);
                // Every cited index points at real evidence.
                for (const item of record.items) {
                    for (const op of item.ops)
                        expect(record.text!.ops[op]).toBeDefined();
                    for (const region of item.regions)
                        expect(record.visual!.regions[region]).toBeDefined();
                }

                // Both Changes so far fired the webhook Reaction, body = the record.
                const deliveries = await sinkRequests(webhook, 2);
                expect(deliveries.length).toBeGreaterThanOrEqual(2);
                const last = JSON.parse(deliveries.at(-1)!.body) as {
                    id?: string;
                    summary?: string;
                };
                expect(last.id).toBe(change.id);
                expect(last.summary).toBe(record.summary);
            },
            RUN,
        );

        it(
            "does not hide a plan that was added after the page was planned",
            async () => {
                // The plan was drawn around three plans. A fourth must still
                // reach the agent rather than fall into an ignored part.
                await setVariant("storefront", "v4");
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("new plan run", run);
                expect(run.status).toBe("succeeded");
                expect(run.input_tokens, "the agent was asked").toBeGreaterThan(
                    0,
                );
                const change = (await changeOf(user, run.run_id))!;
                expect(change.suppressed_by).not.toContain("ignored_section");
                const record = await recordOf(user, change);
                note("new plan change", {
                    status: record.status,
                    summary: record.summary,
                    items: record.items,
                });
                expect(JSON.stringify(record.text?.ops)).toMatch(/Enterprise/);
            },
            RUN,
        );

        it("serves the Capture's screenshot to its owner only", async () => {
            const captures = await (
                await fetch(
                    `${config.postgrestUrl}/captures?monitor_id=eq.${monitor.id}&limit=1`,
                    {
                        headers: { authorization: `Bearer ${user.jwt}` },
                    },
                )
            ).json();
            const key = (captures as { screenshot_key: string }[])[0]!
                .screenshot_key;
            const mine = await fetchObject(user, key);
            expect(mine.status).toBe(200);
            expect(mine.headers.get("content-type")).toMatch(/image\//);
            const anonymous = await fetch(
                `${config.webUrl}/api/v1/objects/${key}?inline=1`,
            );
            expect(anonymous.status).toBeGreaterThanOrEqual(400);
        });
    });

    describe("account: a Macro recorded, replayed and repaired by the agent", () => {
        const PASSWORD = "northwind-demo";
        let monitor: Monitor;
        let macro: Macro;

        beforeAll(async () => {
            await setVariant("account", "v1");
            monitor = await createMonitor(user, {
                name: "Northwind annual price",
                url: "account",
                instructions:
                    "Tell me when the annual price of the Team plan changes. Ignore everything else.",
                connection_id: connection.id,
            });
            await putMonitorSecret(
                user,
                monitor.id,
                "email",
                "owner@northwind.test",
            );
            await putMonitorSecret(user, monitor.id, "password", PASSWORD);
        });

        it("records a Macro from a goal, without ever seeing the password", async () => {
            macro = await recordMacro(
                user,
                monitor.id,
                "Sign in, open the Billing tab, and switch the billing period to Annual.",
            );
            note("recorded macro", {
                status: macro.status,
                note: macro.note,
                steps: macro.steps.map(s => ({
                    type: s.type,
                    intent: s.intent,
                    optional: s.optional ?? false,
                    selectors: "selectors" in s ? s.selectors : undefined,
                    value: "value" in s ? s.value : undefined,
                })),
            });
            expect(macro.status).toBe("draft");
            expect(macro.source).toBe("agent");
            const json = JSON.stringify(macro.steps);
            expect(json).toContain("{{secret:password}}");
            expect(json).not.toContain(PASSWORD);
            expect(
                macro.steps.some(
                    s =>
                        s.type === "click" &&
                        /billing/i.test(JSON.stringify(s)),
                ),
            ).toBe(true);
            expect(
                macro.steps.some(
                    s =>
                        s.type === "click" && /annual/i.test(JSON.stringify(s)),
                ),
            ).toBe(true);

            // The trace a person watches while it records, with screenshots.
            const trace = (await (
                await fetch(
                    `${config.postgrestUrl}/run_steps?macro_id=eq.${macro.id}&order=seq.asc`,
                    {
                        headers: { authorization: `Bearer ${user.jwt}` },
                    },
                )
            ).json()) as {
                phase: string;
                screenshot_key: string | null;
                detail: unknown;
            }[];
            expect(trace.length).toBeGreaterThan(0);
            expect(JSON.stringify(trace)).not.toContain(PASSWORD);
            const shot = trace.find(s => s.screenshot_key)?.screenshot_key;
            expect(shot, "a step screenshot").toBeTruthy();
            expect((await fetchObject(user, shot!)).status).toBe(200);

            await approveMacro(macro);
        }, 480_000);

        it(
            "replays the Macro and captures the page behind it",
            async () => {
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("account baseline", run);
                expect(run.status).toBe("succeeded");
                expect(run.verdict).toBe("baseline");
                expect(run.macro_status).toBe("ok");
                const steps = (await runSteps(user, run.run_id)).filter(
                    s => s.phase === "macro",
                );
                expect(steps.length).toBe(macro.steps.length);
                expect(
                    steps.every(
                        s => s.status === "ok" || s.status === "skipped",
                    ),
                ).toBe(true);
            },
            RUN,
        );

        it(
            "finds a Change behind the sign-in, reusing the saved session",
            async () => {
                await setVariant("account", "v2");
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("account change run", run);
                expect(run.status).toBe("succeeded");
                expect(run.macro_status).toBe("ok");
                expect(run.verdict).toBe("change");
                const record = await recordOf(
                    user,
                    (await changeOf(user, run.run_id))!,
                );
                note("account change", {
                    summary: record.summary,
                    items: record.items,
                });
                expect(record.summary).toMatch(/1,?188/);
                expect(
                    record.items.some(
                        i => /948/.test(i.before) && /1,?188/.test(i.after),
                    ),
                ).toBe(true);

                // Signed in already, so the sign-in steps had nothing to do.
                const steps = (await runSteps(user, run.run_id)).filter(
                    s => s.phase === "macro",
                );
                note(
                    "macro steps on the second run",
                    steps.map(s => `${s.seq} ${s.status} ${s.title}`),
                );
                expect(steps.some(s => s.status === "skipped")).toBe(true);
            },
            RUN,
        );

        it(
            "repairs the Macro when the site renames the tab",
            async () => {
                await setVariant("account", "renamed");
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("repair run", run);
                expect(run.status).toBe("succeeded");
                expect(run.macro_status).toBe("repaired");
                expect(run.input_tokens).toBeGreaterThan(0);

                const versions = await macrosOf(user, monitor.id);
                note(
                    "macro versions",
                    versions.map(
                        v => `v${v.version} ${v.status} ${v.source}: ${v.note}`,
                    ),
                );
                const active = versions.find(v => v.status === "active")!;
                expect(active.source).toBe("repair");
                expect(active.version).toBeGreaterThan(macro.version);
                expect(JSON.stringify(active.steps)).toMatch(
                    /Plans & invoices/,
                );
                expect(versions.find(v => v.id === macro.id)!.status).toBe(
                    "archived",
                );

                const steps = await runSteps(user, run.run_id);
                expect(steps.some(s => s.phase === "repair")).toBe(true);
                // The price is unchanged since the last Run, so nothing to report.
                expect(run.verdict).not.toBe("change");
            },
            RUN,
        );

        it(
            "replays the repaired Macro with no model call",
            async () => {
                const run = await runAndWait(monitor.id, { timeout: RUN });
                note("after repair", run);
                expect(run.status).toBe("succeeded");
                expect(run.macro_status).toBe("ok");
                expect(run.verdict).toBe("none");
                expect(run.input_tokens).toBe(0);
            },
            RUN,
        );
    });
});
