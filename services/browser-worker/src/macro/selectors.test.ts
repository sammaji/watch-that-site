import type { ElementHandle, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
    BrowserPool,
    BrowserPoolContextLease,
} from "../lib/browser-pool.js";
import { launchPool } from "../testing/harness.js";
import { generateSelectors, isStableId, locatorFor } from "./selectors.js";

const fixture = `<!doctype html><html><body>
  <div id="cookie-banner" class="cookie-consent"><button>Accept all</button></div>
  <nav><a href="/billing">Billing</a> <a href="https://other.example/x">Partner</a></nav>
  <form action="https://app.example/login" method="post">
    <label for="user">Email</label><input id="user" name="email" type="email" autocomplete="username">
    <label>Password <input name="pw" type="password"></label>
    <input name="q" placeholder="Search invoices" aria-label="Search">
    <button type="submit" data-testid="signin-btn">Sign in</button>
  </form>
  <button id=":r3:">Annual</button>
  <button id="plan-toggle-48213">Monthly</button>
  <div><button>Remove</button></div><div><button>Remove</button></div>
  <span id="status" onclick="1">Status: active</span>
</body></html>`;

let pool: BrowserPool;
let lease: BrowserPoolContextLease;
let page: Page;

beforeAll(async () => {
    pool = await launchPool();
    lease = await pool.acquire();
    page = await lease.context.newPage();
    await page.setContent(fixture);
});

afterAll(async () => {
    await lease?.release();
    await pool?.close();
});

const handle = async (css: string, nth = 0) =>
    (await page
        .locator(css)
        .nth(nth)
        .elementHandle()) as ElementHandle<Element>;

/** Every selector must resolve to that one element and nothing else. */
async function expectAllResolve(
    selectors: string[],
    el: ElementHandle<Element>,
) {
    for (const selector of selectors) {
        const locator = locatorFor(page, selector);
        expect(await locator.count(), selector).toBe(1);
        expect(await locator.evaluate((a, b) => a === b, el), selector).toBe(
            true,
        );
    }
}

describe("generateSelectors", () => {
    it("ranks role and name first, then test id, text, and XPath last, for a button", async () => {
        const el = await handle("button[type=submit]");
        const gen = await generateSelectors(page, el);
        expect(gen.selectors).toEqual([
            'role=button[name="Sign in"]',
            "data-testid=signin-btn",
            'text="Sign in"',
            "xpath=/html[1]/body[1]/form[1]/button[1]",
        ]);
        expect(gen.description).toBe('button "Sign in"');
        await expectAllResolve(gen.selectors, el);
    });

    it("uses the label, a stable id and the name attribute for a field", async () => {
        const el = await handle("#user");
        const gen = await generateSelectors(page, el);
        expect(gen.selectors).toEqual([
            'role=textbox[name="Email"]',
            'label="Email"',
            "css=#user",
            'css=input[name="email"]',
            "xpath=/html[1]/body[1]/form[1]/input[1]",
        ]);
        await expectAllResolve(gen.selectors, el);
    });

    it("uses the placeholder", async () => {
        const el = await handle("input[name=q]");
        const gen = await generateSelectors(page, el);
        expect(gen.selectors).toContain('placeholder="Search invoices"');
        expect(gen.selectors).toContain('label="Search"');
        await expectAllResolve(gen.selectors, el);
    });

    it("leaves out ids a framework generates", async () => {
        expect(isStableId("plan-toggle")).toBe(true);
        expect(isStableId(":r3:")).toBe(false);
        expect(isStableId("plan-toggle-48213")).toBe(false);
        expect(isStableId("radix-12")).toBe(false);
        expect(isStableId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(false);

        for (const css of ["button >> text=Annual", "button >> text=Monthly"]) {
            const el = (await page
                .locator(css)
                .elementHandle()) as ElementHandle<Element>;
            const gen = await generateSelectors(page, el);
            expect(gen.selectors.some(s => s.startsWith("css=#"))).toBe(false);
            await expectAllResolve(gen.selectors, el);
        }
    });

    it("keeps only selectors that single the element out", async () => {
        // Two "Remove" buttons: name and text match both, so only the XPath is left.
        const el = await handle("div > button", 2);
        const gen = await generateSelectors(page, el);
        expect(gen.selectors).toEqual([
            "xpath=/html[1]/body[1]/div[3]/button[1]",
        ]);
        await expectAllResolve(gen.selectors, el);
    });

    it("recognises sign-in fields, password fields and cookie banners", async () => {
        const email = await generateSelectors(page, await handle("#user"));
        expect(email.facts).toMatchObject({
            signIn: true,
            isPassword: false,
            cookieBanner: false,
        });

        const password = await generateSelectors(
            page,
            await handle("input[name=pw]"),
        );
        expect(password.facts).toMatchObject({
            signIn: true,
            isPassword: true,
        });
        expect(password.selectors[0]).toBe('role=textbox[name="Password"]');

        const submit = await generateSelectors(
            page,
            await handle("button[type=submit]"),
        );
        expect(submit.facts.signIn).toBe(true);
        expect(submit.facts.formAction).toBe("https://app.example/login");

        const accept = await generateSelectors(
            page,
            await handle("#cookie-banner button"),
        );
        expect(accept.facts).toMatchObject({
            cookieBanner: true,
            signIn: false,
        });

        const toggle = await generateSelectors(page, await handle("#status"));
        expect(toggle.facts).toMatchObject({
            cookieBanner: false,
            signIn: false,
        });
    });

    it("reports where a link goes", async () => {
        const partner = await generateSelectors(page, await handle("nav a", 1));
        expect(partner.facts.href).toBe("https://other.example/x");
        expect(partner.selectors[0]).toBe('role=link[name="Partner"]');
    });
});
