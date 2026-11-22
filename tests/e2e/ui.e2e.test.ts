/**
 * The screens, end to end: a person signs in, creates Monitors through the
 * form, and reads what the product found, in a real browser against the
 * running stack and a real model.
 *
 * Complements agentic.e2e.test.ts, which checks the same pipeline through the
 * services' own doors. Here the assertions are about what the owner sees and
 * what their clicks do. Screenshots of every screen are written to
 * E2E_SHOTS_DIR when it is set.
 *
 * Needs the stack and TEST_OPENAI_API_KEY; skipped without the key.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Macro, Monitor } from "../../packages/types/src/index";
import {
    closeDb,
    createTestUser,
    deleteTestUser,
    type TestUser,
} from "../lib/users";
import {
    config,
    createConnection,
    fixtureUrl,
    requireStack,
    select,
    setVariant,
} from "./lib";

const SHOTS = process.env.E2E_SHOTS_DIR ?? "";
const LONG = 300_000;

describe.skipIf(!config.openaiKey)("the screens, end to end", () => {
    let user: TestUser;
    let browser: Browser;
    let page: Page;
    const consoleErrors: string[] = [];

    async function shot(name: string) {
        if (!SHOTS) return;
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({
            path: join(SHOTS, `${name}.png`),
            fullPage: true,
        });
    }

    const id = (testId: string) => page.locator(`[data-testid="${testId}"]`);

    beforeAll(async () => {
        await requireStack({ sinks: false });
        user = await createTestUser("screens");
        await createConnection(user);

        browser = await chromium.launch();
        page = await (
            await browser.newContext({ viewport: { width: 1366, height: 900 } })
        ).newPage();
        page.on("console", message => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", error =>
            consoleErrors.push(`pageerror: ${error.message}`),
        );

        await page.goto(`${config.webUrl}/login`);
        await page.fill("#email", user.email);
        await page.fill("#password", user.password);
        await page.click('button[type="submit"]');
        await page.waitForURL(/\/home/, { timeout: 30_000 });
    }, 90_000);

    afterAll(async () => {
        await browser?.close();
        if (!process.env.E2E_KEEP_USER) await deleteTestUser(user);
        else console.log(`[e2e] kept user ${user.email} / ${user.password}`);
        await closeDb();
    });

    describe("a public page", () => {
        let monitorId = "";

        it(
            "creates a Monitor from three fields and shows its Baseline",
            async () => {
                await setVariant("storefront", "v1");
                await page.goto(`${config.webUrl}/monitors/create`);
                await page.fill("#monitor-url", fixtureUrl("diff/storefront"));
                await page.fill("#monitor-name", "Northwind storefront");
                await page.fill(
                    "#monitor-instructions",
                    "Tell me when the price of a plan changes, or when the hero image is replaced. Ignore the customer testimonials.",
                );
                await shot("01-create-form");
                await page
                    .getByRole("button", {
                        name: "Save and run the first check",
                    })
                    .click();
                await page.waitForURL(/\/monitors\/[0-9a-f-]{36}/, {
                    timeout: 30_000,
                });
                monitorId = /monitors\/([0-9a-f-]{36})/.exec(page.url())![1]!;

                // The first Run becomes the Baseline; the timeline says so on its own.
                await expect
                    .poll(
                        async () =>
                            (await id("timeline-run").allInnerTexts()).join(
                                " | ",
                            ),
                        {
                            timeout: 120_000,
                            interval: 1_000,
                        },
                    )
                    .toMatch(/Baseline/i);
                await shot("02-monitor-baseline");
            },
            LONG,
        );

        it(
            "shows how the agent decided to watch the page, and lets the owner change it",
            async () => {
                await id("tab-plan").click();
                await expect
                    .poll(async () => id("plan-section").count(), {
                        timeout: 60_000,
                    })
                    .toBeGreaterThanOrEqual(3);
                const sections = (
                    await id("plan-section").allInnerTexts()
                ).join("\n");
                expect(sections).toMatch(/testimonial/i);
                await shot("03-watch-plan");

                const stored = (
                    await select<Monitor>(user, `monitors?id=eq.${monitorId}`)
                )[0]!;
                expect(
                    stored.watch_plan?.sections.length,
                ).toBeGreaterThanOrEqual(3);
            },
            LONG,
        );

        it(
            "reports a price rise, and the Change view opens on the answer",
            async () => {
                await setVariant("storefront", "v2");
                await id("run-now").click();
                await id("tab-changes").click();
                await expect
                    .poll(
                        async () =>
                            (await id("change-card").allInnerTexts()).join(
                                " | ",
                            ),
                        {
                            timeout: 120_000,
                            interval: 1_000,
                        },
                    )
                    .toMatch(/129/);
                await shot("04-monitor-changes");

                await id("change-card")
                    .filter({ hasText: "129" })
                    .first()
                    .click();
                await page.waitForURL(/\/changes\/[0-9a-f-]{36}/, {
                    timeout: 30_000,
                });
                await expect
                    .poll(async () => id("change-summary").innerText(), {
                        timeout: 30_000,
                    })
                    .toMatch(/129/);
                await expect
                    .poll(async () => id("change-item").count(), {
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0);
                const item = await id("change-item").first().innerText();
                expect(item).toMatch(/99/);
                expect(item).toMatch(/129/);
                // Let the screenshot crops load before the picture is taken.
                await page
                    .waitForLoadState("networkidle")
                    .catch(() => undefined);
                await shot("05-change-what-changed");

                await id("tab-side").click();
                await expect
                    .poll(async () => id("side-by-side").count(), {
                        timeout: 30_000,
                    })
                    .toBe(1);
                await page
                    .waitForLoadState("networkidle")
                    .catch(() => undefined);
                await shot("06-change-side-by-side");

                await id("tab-text").click();
                // The page text is fetched when the tab opens.
                await expect
                    .poll(async () => id("full-text").innerText(), {
                        timeout: 30_000,
                    })
                    .toMatch(/129/);
                await shot("07-change-full-text");

                await id("tab-trace").click();
                await expect
                    .poll(async () => id("trace-step").count(), {
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0);
                await shot("08-change-how-it-was-checked");

                await id("this-was-useful").click();
                await expect
                    .poll(
                        async () =>
                            (
                                await select<{ user_feedback: string | null }>(
                                    user,
                                    `changes?monitor_id=eq.${monitorId}&status=eq.change&select=user_feedback`,
                                )
                            ).map(c => c.user_feedback),
                        { timeout: 15_000 },
                    )
                    .toContain("useful");
            },
            LONG,
        );
    });

    describe("a page behind a sign-in", () => {
        let monitorId = "";

        it(
            "records a Macro from the create form and shows it for approval",
            async () => {
                await setVariant("account", "v1");
                await page.goto(`${config.webUrl}/monitors/create`);
                await page.fill("#monitor-url", fixtureUrl("account"));
                await page.fill("#monitor-name", "Northwind annual price");
                await page.fill(
                    "#monitor-instructions",
                    "Tell me when the annual price of the Team plan changes. Ignore everything else.",
                );
                await page
                    .getByRole("button", { name: /Before each check/ })
                    .click();
                await page.fill(
                    "#monitor-goal",
                    "Sign in, open the Billing tab, and switch the billing period to Annual.",
                );
                await page
                    .getByRole("button", { name: "Add a secret" })
                    .click();
                await page.getByLabel("Name of secret 1").fill("email");
                await page
                    .getByLabel("Value of secret 1")
                    .fill("owner@northwind.test");
                await page
                    .getByRole("button", { name: "Add a secret" })
                    .click();
                await page.getByLabel("Name of secret 2").fill("password");
                await page
                    .getByLabel("Value of secret 2")
                    .fill("northwind-demo");
                await shot("09-create-form-with-macro");
                await page
                    .getByRole("button", { name: "Save and record the Macro" })
                    .click();
                await page.waitForURL(/\/monitors\/[0-9a-f-]{36}/, {
                    timeout: 30_000,
                });
                monitorId = /monitors\/([0-9a-f-]{36})/.exec(page.url())![1]!;

                // The agent works; the page follows along and ends on a draft.
                await expect
                    .poll(
                        async () =>
                            (await id("macro-draft").count()) +
                            (await id("macro-failed").count()),
                        {
                            timeout: 240_000,
                            interval: 1_500,
                        },
                    )
                    .toBe(1);
                expect(
                    await id("macro-failed").count(),
                    "the recording failed",
                ).toBe(0);
                expect(await id("macro-step").count()).toBeGreaterThanOrEqual(
                    4,
                );
                // The password is shown as a reference, never as a value.
                const body = await page.locator("body").innerText();
                expect(body).not.toContain("northwind-demo");
                await page
                    .waitForLoadState("networkidle")
                    .catch(() => undefined);
                await shot("10-macro-draft");
            },
            LONG,
        );

        it(
            "approves the Macro, which takes the Baseline behind the sign-in",
            async () => {
                await id("approve-macro").click();
                await expect
                    .poll(async () => id("macro-active").count(), {
                        timeout: 30_000,
                    })
                    .toBe(1);
                const macros = await select<Macro>(
                    user,
                    `macros?monitor_id=eq.${monitorId}&status=eq.active`,
                );
                expect(macros).toHaveLength(1);

                await id("tab-timeline").click();
                await expect
                    .poll(
                        async () =>
                            (await id("timeline-run").allInnerTexts()).join(
                                " | ",
                            ),
                        {
                            timeout: 180_000,
                            interval: 1_500,
                        },
                    )
                    .toMatch(/Baseline/i);
                await id("tab-macro").click();
                await page
                    .waitForLoadState("networkidle")
                    .catch(() => undefined);
                await shot("11-macro-active");
            },
            LONG,
        );

        it(
            "finds the Change behind the sign-in and shows the Macro in the trace",
            async () => {
                await setVariant("account", "v2");
                await id("run-now").click();
                await id("tab-changes").click();
                await expect
                    .poll(
                        async () =>
                            (await id("change-card").allInnerTexts()).join(
                                " | ",
                            ),
                        {
                            timeout: 180_000,
                            interval: 1_500,
                        },
                    )
                    .toMatch(/1,?188/);
                await id("change-card")
                    .filter({ hasText: "188" })
                    .first()
                    .click();
                await page.waitForURL(/\/changes\/[0-9a-f-]{36}/, {
                    timeout: 30_000,
                });
                await expect
                    .poll(async () => id("change-summary").innerText(), {
                        timeout: 30_000,
                    })
                    .toMatch(/1,?188/);
                await id("tab-trace").click();
                await expect
                    .poll(async () => id("trace-step").count(), {
                        timeout: 30_000,
                    })
                    .toBeGreaterThanOrEqual(4);
                expect(await id("run-trace").innerText()).toMatch(/Annual/i);
                await page
                    .waitForLoadState("networkidle")
                    .catch(() => undefined);
                await shot("12-change-behind-sign-in-trace");
            },
            LONG,
        );
    });

    it("logged no errors in the browser console", () => {
        const real = consoleErrors.filter(
            line =>
                // The page-title lookup for a localhost fixture URL is refused by design.
                !/api\/v1\/metadata/.test(line) &&
                // Known and harmless in development: a Radix menu trigger's
                // generated id differs between the server render and hydration
                // on a full page load. Only the id attribute is affected.
                !/hydrated but some attributes/.test(line),
        );
        expect(real).toEqual([]);
    });
});
