import type { MacroStep } from "@watchthatsite/types";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
    BrowserPool,
    BrowserPoolContextLease,
} from "../lib/browser-pool.js";
import {
    html,
    launchPool,
    startServer,
    type FixtureServer,
} from "../testing/harness.js";
import {
    createPlayer,
    failureMessage,
    playMacro,
    playStep,
    type StepHook,
} from "./player.js";
import { locatorFor } from "./selectors.js";

const SECRET = "s3cr3t-Passw0rd!-do-not-leak";

const form = html(
    `<h1>Account</h1>
     <form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Saved ' + document.getElementById('email').value + ' / ' + document.getElementById('pw').value.length + ' chars / token ' + document.getElementById('token').value">
       <label for="email">Email address</label>
       <input id="email" name="email" type="email" placeholder="you@example.com">
       <label for="pw">Password</label>
       <input id="pw" name="pw" type="password">
       <label for="token">API token</label>
       <input id="token" name="token" type="text">
       <label for="plan">Plan</label>
       <select id="plan" name="plan" onchange="document.getElementById('chosen').textContent = 'Plan: ' + this.value">
         <option value="monthly">Monthly</option><option value="annual">Annual</option>
       </select>
       <button type="submit" data-testid="save">Save changes</button>
     </form>
     <p id="out"></p><p id="chosen"></p>
     <button class="dup">Duplicate</button><button class="dup">Duplicate</button>
     <button id="hidden-one" style="display:none">Ghost</button>
     <button id="late" style="display:none" onclick="document.getElementById('out').textContent = 'late clicked'">Appears late</button>
     <a id="next" href="/next">Go to next page</a>
     <div style="height:2000px"></div><p id="bottom">Bottom of page</p>
     <script>
       setTimeout(() => { document.getElementById("late").style.display = ""; }, 700);
       document.addEventListener("keydown", e => { if (e.key === "Escape") document.getElementById("out").textContent = "escaped"; });
     </script>`,
    "<title>Form</title>",
);

let server: FixtureServer;
let pool: BrowserPool;
let lease: BrowserPoolContextLease;
let page: Page;

beforeAll(async () => {
    server = await startServer({
        "/form": form,
        "/next": html("<h1>Next page</h1><p>You made it.</p>"),
    });
    pool = await launchPool();
    lease = await pool.acquire();
    page = await lease.context.newPage();
});

afterAll(async () => {
    await lease?.release();
    await pool?.close();
    await server?.close();
});

beforeEach(async () => {
    await page.goto(`${server.origin}/form`);
});

const secrets = async (name: string) =>
    name === "password" ? SECRET
    : name === "token" ? "tok_live_98765"
    : null;
const player = () => createPlayer(page, secrets);
const out = () => page.locator("#out").innerText();

describe("locatorFor", () => {
    it("runs in a context that has the helper tsx-compiled page functions need", async () => {
        // Under tsx, functions passed to page.evaluate arrive in the page
        // wrapped in __name(...). The pool defines it in every context; if it
        // stops doing so, every Capture fails in production and no other unit
        // test notices, because Vitest does not add the wrapper.
        expect(
            await page.evaluate(
                () => typeof (globalThis as { __name?: unknown }).__name,
            ),
        ).toBe("function");
    });

    it("maps label= and placeholder= to Playwright's locators, quoted meaning exact", async () => {
        expect(await locatorFor(page, 'label="Email address"').count()).toBe(1);
        expect(await locatorFor(page, "label=email").count()).toBe(1);
        expect(await locatorFor(page, 'label="email"').count()).toBe(0);
        expect(
            await locatorFor(page, "placeholder=you@example.com").getAttribute(
                "id",
            ),
        ).toBe("email");
        expect(await locatorFor(page, "data-testid=save").innerText()).toBe(
            "Save changes",
        );
    });

    it("passes role=, text=, css= and xpath= through", async () => {
        expect(
            await locatorFor(page, 'role=button[name="Save changes"]').count(),
        ).toBe(1);
        expect(
            await locatorFor(page, 'text="Go to next page"').getAttribute("id"),
        ).toBe("next");
        expect(await locatorFor(page, "css=#plan").count()).toBe(1);
        expect(
            await locatorFor(
                page,
                "xpath=//form//input[@type='password']",
            ).getAttribute("id"),
        ).toBe("pw");
    });
});

describe("playStep: finding the element", () => {
    it("uses the first selector that matches exactly one visible element", async () => {
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Save",
                selectors: [
                    "css=#gone-after-redesign",
                    'role=button[name="Save changes"]',
                    "data-testid=save",
                ],
            },
            0,
        );
        expect(result).toMatchObject({
            status: "ok",
            selector: 'role=button[name="Save changes"]',
            error: "",
        });
        expect(await out()).toContain("Saved");
    });

    it("does not let a dead first selector eat the step's whole budget", async () => {
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Save",
                selectors: ["css=#gone", "css=#also-gone", "data-testid=save"],
                timeout_ms: 10_000,
            },
            0,
        );
        expect(result.status).toBe("ok");
        expect(result.selector).toBe("data-testid=save");
        // Two dead selectors cost their head starts, not ten seconds each.
        expect(result.durationMs).toBeLessThan(4_000);
    });

    it("skips a selector that matches several elements, or only a hidden one", async () => {
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Save",
                selectors: ["css=.dup", "css=#hidden-one", "text=Save changes"],
                timeout_ms: 3_000,
            },
            0,
        );
        expect(result).toMatchObject({
            status: "ok",
            selector: "text=Save changes",
        });
    });

    it("waits for an element that appears later", async () => {
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Click the late button",
                selectors: ["css=#late"],
                timeout_ms: 5_000,
            },
            0,
        );
        expect(result.status).toBe("ok");
        expect(await out()).toBe("late clicked");
    });

    it("fails with a message a person can act on", async () => {
        const step: MacroStep = {
            type: "click",
            intent: "Open the Billing tab",
            selectors: ['role=tab[name="Billing"]', "css=#billing"],
            timeout_ms: 600,
        };
        const result = await playStep(player(), step, 2);
        expect(result).toMatchObject({
            status: "failed",
            selector: null,
            error: "no element matched",
        });
        expect(failureMessage(2, step, result.error)).toBe(
            "Step 3 (Open the Billing tab) could not be completed: no element matched",
        );
    });

    it("says so when the only match is ambiguous", async () => {
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Duplicate",
                selectors: ["css=.dup"],
                timeout_ms: 500,
            },
            0,
        );
        expect(result.status).toBe("failed");
        expect(result.error).toBe("2 elements matched css=.dup, expected one");
    });

    it("does not act on a position alone when the element's names stopped matching", async () => {
        // The Save button was recorded by name and by position. Its names no
        // longer match; something sits where it used to be.
        const where = await page
            .locator('[data-testid="save"]')
            .evaluate(el => {
                const steps: string[] = [];
                for (let n: Element | null = el; n; n = n.parentElement) {
                    let i = 1;
                    for (
                        let p = n.previousElementSibling;
                        p;
                        p = p.previousElementSibling
                    ) {
                        if (p.tagName === n.tagName) i++;
                    }
                    steps.unshift(`${n.tagName.toLowerCase()}[${i}]`);
                }
                return `xpath=/${steps.join("/")}`;
            });
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Submit the form",
                selectors: [
                    'role=button[name="Submit"]',
                    'text="Submit"',
                    where,
                ],
                timeout_ms: 600,
            },
            0,
        );
        expect(result).toMatchObject({ status: "failed", selector: null });
        expect(result.error).toBe(
            'no element matched by name; where it used to be there is now a button reading "Save changes"',
        );
        expect(await page.locator("#out").textContent()).toBe("");

        // A step written with a position only is taken at its word.
        const byHand = await playStep(
            player(),
            { type: "click", intent: "Submit the form", selectors: [where] },
            0,
        );
        expect(byHand).toMatchObject({ status: "ok", selector: where });
        expect(await page.locator("#out").textContent()).toContain("Saved");
    });

    it("skips an optional step whose element never shows up", async () => {
        const result = await playStep(
            player(),
            {
                type: "click",
                intent: "Accept cookies",
                selectors: ["css=#accept-cookies"],
                optional: true,
                timeout_ms: 400,
            },
            0,
        );
        expect(result).toMatchObject({ status: "skipped", selector: null });
    });
});

describe("playStep: the actions", () => {
    it("fills, selects, presses and scrolls", async () => {
        const p = player();
        expect(
            (
                await playStep(
                    p,
                    {
                        type: "fill",
                        intent: "",
                        selectors: ["label=Email address"],
                        value: "a@b.test",
                    },
                    0,
                )
            ).status,
        ).toBe("ok");
        expect(await page.inputValue("#email")).toBe("a@b.test");

        expect(
            (
                await playStep(
                    p,
                    {
                        type: "select",
                        intent: "",
                        selectors: ["label=Plan"],
                        value: "annual",
                    },
                    1,
                )
            ).status,
        ).toBe("ok");
        expect(await page.locator("#chosen").innerText()).toBe("Plan: annual");

        expect(
            (await playStep(p, { type: "press", intent: "", key: "Escape" }, 2))
                .status,
        ).toBe("ok");
        expect(await out()).toBe("escaped");

        expect(
            (
                await playStep(
                    p,
                    {
                        type: "press",
                        intent: "",
                        key: "Enter",
                        selectors: ["css=#email"],
                    },
                    3,
                )
            ).status,
        ).toBe("ok");
        expect(await out()).toContain("Saved a@b.test");

        expect(
            (
                await playStep(
                    p,
                    { type: "scroll", intent: "", selectors: ["css=#bottom"] },
                    4,
                )
            ).status,
        ).toBe("ok");
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
        expect(
            (await playStep(p, { type: "scroll", intent: "", y: -10_000 }, 5))
                .status,
        ).toBe("ok");
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });

    it("waits for text, and for a fixed time", async () => {
        const p = player();
        expect(
            (
                await playStep(
                    p,
                    {
                        type: "wait_for",
                        intent: "",
                        text: "Appears late",
                        timeout_ms: 5_000,
                    },
                    0,
                )
            ).status,
        ).toBe("ok");
        const failed = await playStep(
            p,
            {
                type: "wait_for",
                intent: "",
                text: "Never shown",
                timeout_ms: 300,
            },
            1,
        );
        expect(failed).toMatchObject({
            status: "failed",
            error: 'the text "Never shown" did not appear',
        });
        const waited = await playStep(
            p,
            { type: "wait", intent: "", ms: 250 },
            2,
        );
        expect(waited.status).toBe("ok");
        expect(waited.durationMs).toBeGreaterThanOrEqual(240);
    });

    it("settles after a click that navigates", async () => {
        const result = await playStep(
            player(),
            { type: "click", intent: "", selectors: ["css=#next"] },
            0,
        );
        expect(result.status).toBe("ok");
        expect(page.url()).toBe(`${server.origin}/next`);
        expect(await page.locator("h1").innerText()).toBe("Next page");
    });

    it("navigates to http(s) URLs only", async () => {
        const p = player();
        expect(
            (
                await playStep(
                    p,
                    {
                        type: "navigate",
                        intent: "",
                        url: `${server.origin}/next`,
                    },
                    0,
                )
            ).status,
        ).toBe("ok");
        expect(page.url()).toBe(`${server.origin}/next`);
        for (const url of [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "chrome://settings",
            "not a url",
        ]) {
            const result = await playStep(
                p,
                { type: "navigate", intent: "", url },
                1,
            );
            expect(result.status, url).toBe("failed");
        }
        expect(page.url()).toBe(`${server.origin}/next`);
    });
});

describe("secrets", () => {
    it("types {{secret:name}} into the field without the value leaving the player", async () => {
        const p = player();
        const seen: unknown[] = [];
        const hook: StepHook = async event => {
            seen.push({ step: event.step, result: event.result });
        };
        const steps: MacroStep[] = [
            {
                type: "fill",
                intent: "Type the password",
                selectors: ["label=Password"],
                value: "{{secret:password}}",
            },
            {
                type: "fill",
                intent: "Type the token",
                selectors: ["label=API token"],
                value: "Bearer {{secret:token}}",
            },
            { type: "click", intent: "Save", selectors: ["data-testid=save"] },
        ];
        const replay = await playMacro(p, steps, hook);

        expect(replay.ok).toBe(true);
        // The page got the real values...
        expect(await page.inputValue("#pw")).toBe(SECRET);
        expect(await page.inputValue("#token")).toBe("Bearer tok_live_98765");
        // ...and nothing the player hands back holds them.
        const handedBack = JSON.stringify({ replay, seen, steps });
        expect(handedBack).not.toContain(SECRET);
        expect(handedBack).not.toContain("tok_live_98765");
        // A secret typed into a field that shows its value is marked, so
        // screenshots cover it; a password field hides itself.
        expect(p.sensitive).toHaveLength(1);
        expect(await p.sensitive[0]!.getAttribute("id")).toBe("token");
    });

    it("scrubs a secret out of text, longest first", async () => {
        const p = player();
        await p.secrets.expand("{{secret:password}} {{secret:token}}");
        expect(p.secrets.scrub(`value="${SECRET}" and tok_live_98765`)).toBe(
            'value="{{secret:password}}" and {{secret:token}}',
        );
    });

    it("fails the step when the Monitor has no such secret", async () => {
        const step: MacroStep = {
            type: "fill",
            intent: "Type the PIN",
            selectors: ["label=Password"],
            value: "{{secret:pin}}",
        };
        const result = await playStep(player(), step, 0);
        expect(result.status).toBe("failed");
        expect(result.error).toContain(
            'the secret "pin" is not set for this Monitor',
        );
        expect(await page.inputValue("#pw")).toBe("");
    });

    it("does not skip an optional step whose secret is missing", async () => {
        const result = await playStep(
            player(),
            {
                type: "fill",
                intent: "",
                selectors: ["label=Password"],
                value: "{{secret:pin}}",
                optional: true,
            },
            0,
        );
        expect(result.status).toBe("failed");
    });
});

describe("playMacro", () => {
    it("stops at the first failed step and reports it", async () => {
        const reached: number[] = [];
        const replay = await playMacro(
            player(),
            [
                {
                    type: "fill",
                    intent: "Type the email",
                    selectors: ["css=#email"],
                    value: "a@b.test",
                },
                {
                    type: "click",
                    intent: "Dismiss the banner",
                    selectors: ["css=#banner-close"],
                    optional: true,
                    timeout_ms: 300,
                },
                {
                    type: "click",
                    intent: "Open settings",
                    selectors: ["css=#settings"],
                    timeout_ms: 300,
                },
                {
                    type: "click",
                    intent: "Save",
                    selectors: ["data-testid=save"],
                },
            ],
            async e => {
                reached.push(e.index);
            },
        );
        expect(replay.ok).toBe(false);
        expect(replay.failedStep).toBe(2);
        expect(replay.error).toBe(
            "Step 3 (Open settings) could not be completed: no element matched",
        );
        expect(replay.steps.map(s => s.status)).toEqual([
            "ok",
            "skipped",
            "failed",
        ]);
        expect(reached).toEqual([0, 1, 2]);
        expect(await out()).toBe("");
    });
});
