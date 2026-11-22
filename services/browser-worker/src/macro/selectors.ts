import type { MacroSelector } from "@watchthatsite/types";
import type { ElementHandle, Locator, Page } from "playwright-core";

/**
 * Macro selectors: turning a selector string into a Playwright locator, and
 * generating ranked selectors from an element the Agent just acted on.
 *
 * A Macro selector is a Playwright selector string with two additions:
 * `label=…` and `placeholder=…`, which Playwright only offers as locator
 * methods. Quoted values (`label="Email"`) match exactly; bare ones
 * (`label=Email`) match case-insensitively on a substring, like `text=`.
 */

function unquote(raw: string): { text: string; exact: boolean } {
    const value = raw.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return {
            text: value.slice(1, -1).replace(/\\(["\\])/g, "$1"),
            exact: true,
        };
    }
    return { text: value, exact: false };
}

/** Quotes a value for `role=…[name="…"]`, `text="…"`, `label="…"`. */
export function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The locator a Macro selector stands for. Throws on an empty selector. */
export function locatorFor(page: Page, selector: MacroSelector): Locator {
    const trimmed = selector.trim();
    if (trimmed === "") throw new Error("empty selector");
    const m = /^(label|placeholder|data-testid)=([\s\S]*)$/.exec(trimmed);
    if (m) {
        const { text, exact } = unquote(m[2]!);
        if (m[1] === "label") return page.getByLabel(text, { exact });
        if (m[1] === "placeholder") {
            return page.getByPlaceholder(text, { exact });
        }
        return page.getByTestId(text);
    }
    // role=, text=, css=, xpath= and bare CSS or XPath are Playwright's own.
    return page.locator(trimmed);
}

/** What the page says about one element, read in a single evaluate. */
export type ElementFacts = {
    tag: string;
    /** `type` of an input or button, lower-case, else "". */
    type: string;
    label: string;
    placeholder: string;
    testId: string;
    /** The element's own visible text, whitespace collapsed. */
    text: string;
    id: string;
    nameAttr: string;
    /** Absolute XPath with an index on every step. */
    xpath: string;
    isPassword: boolean;
    isFormField: boolean;
    /** A field or button of a sign-in form, or a "Sign in" link. */
    signIn: boolean;
    /** Sits inside a cookie or consent banner. */
    cookieBanner: boolean;
    /** Absolute URL of the link the element is (or is inside), else "". */
    href: string;
    /** Absolute action URL of the form a submit control belongs to, else "". */
    formAction: string;
};

export async function readFacts(
    handle: ElementHandle<Element>,
): Promise<ElementFacts> {
    return handle.evaluate((el): ElementFacts => {
        const collapse = (s: string | null | undefined) =>
            (s ?? "").replace(/\s+/g, " ").trim();
        const tag = el.tagName.toLowerCase();
        const input =
            (
                el instanceof HTMLInputElement ||
                el instanceof HTMLTextAreaElement ||
                el instanceof HTMLSelectElement
            ) ?
                el
            :   null;
        const type = collapse(el.getAttribute("type")).toLowerCase();

        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            let index = 1;
            let sibling = current.previousElementSibling;
            while (sibling) {
                if (sibling.tagName === current.tagName) index += 1;
                sibling = sibling.previousElementSibling;
            }
            parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
            current = current.parentElement;
        }

        let label = collapse(el.getAttribute("aria-label"));
        if (!label && input?.labels && input.labels.length > 0) {
            label = collapse(input.labels[0]!.innerText);
        }

        const form =
            input?.form ??
            (el instanceof HTMLButtonElement ? el.form : null) ??
            el.closest("form");
        const isPassword =
            el instanceof HTMLInputElement && el.type === "password";
        const autocomplete = collapse(
            el.getAttribute("autocomplete"),
        ).toLowerCase();
        const signInPage =
            /(sign|log)[-_]?in|login|signon|sso|\bauth|session/i.test(
                location.pathname,
            );
        const inPasswordForm =
            form !== null &&
            form.querySelector('input[type="password"]') !== null;
        const ownName = collapse(
            el instanceof HTMLElement ? el.innerText : el.textContent,
        );
        const signIn =
            isPassword ||
            inPasswordForm ||
            /\b(username|current-password|one-time-code)\b/.test(
                autocomplete,
            ) ||
            (signInPage && form !== null) ||
            /^(sign|log)[ -]?in$|^login$/i.test(
                ownName || collapse(el.getAttribute("aria-label")),
            );

        let cookieBanner = false;
        for (
            let p: Element | null = el;
            p && p !== document.body;
            p = p.parentElement
        ) {
            const marks = `${p.id} ${typeof p.className === "string" ? p.className : ""} ${p.getAttribute("aria-label") ?? ""}`;
            if (/cookie|consent|gdpr|onetrust|\bcmp\b/i.test(marks)) {
                cookieBanner = true;
                break;
            }
        }

        const link = el.closest("a[href]");
        const submits =
            (el instanceof HTMLButtonElement && el.type === "submit") ||
            (el instanceof HTMLInputElement &&
                (el.type === "submit" || el.type === "image"));

        return {
            tag,
            type,
            label,
            placeholder: collapse(el.getAttribute("placeholder")),
            testId: collapse(el.getAttribute("data-testid")),
            text: ownName,
            id: el.id ?? "",
            nameAttr: collapse(el.getAttribute("name")),
            xpath: `/${parts.join("/")}`,
            isPassword,
            isFormField: input !== null,
            signIn,
            cookieBanner,
            href: link instanceof HTMLAnchorElement ? link.href : "",
            formAction:
                (submits || input !== null) && form instanceof HTMLFormElement ?
                    form.action
                :   "",
        };
    });
}

/**
 * The element's role and accessible name as Playwright's own `role=` engine
 * computes them, read off the first line of its ARIA snapshot
 * (`- button "Sign in"`). Null when the element has no role or no name.
 */
export async function roleAndName(
    locator: Locator,
): Promise<{ role: string; name: string } | null> {
    let snapshot: string;
    try {
        snapshot = await locator.ariaSnapshot({ timeout: 2_000 });
    } catch {
        return null;
    }
    let line = (snapshot.split("\n")[0] ?? "").trim();
    // YAML single-quotes a line that contains characters such as ": ".
    const quoted = /^- '(.*)'(:)?$/.exec(line);
    if (quoted) line = `- ${quoted[1]!.replace(/''/g, "'")}`;
    const m = /^- ([a-z]+) "((?:[^"\\]|\\.)*)"/.exec(line);
    if (!m) return null;
    const role = m[1]!;
    const name = m[2]!.replace(/\\(["\\])/g, "$1").trim();
    if (role === "text" || role === "generic" || name === "") return null;
    return { role, name };
}

/** Ids that frameworks generate fresh on every render are useless as selectors. */
export function isStableId(id: string): boolean {
    if (id === "" || id.length > 60) return false;
    if (/[:\s]/.test(id)) return false; // React's `:r1:`, malformed ids
    if (/\d{4,}/.test(id)) return false; // counters, timestamps
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false; // UUIDs
    if (/^(ember|radix-|headlessui-|mui-|react-aria)/i.test(id)) return false;
    return /^[A-Za-z][\w-]*$/.test(id);
}

/** Candidate selectors for an element, most stable first, before checking. */
export function candidateSelectors(
    facts: ElementFacts,
    aria: { role: string; name: string } | null,
): MacroSelector[] {
    const out: MacroSelector[] = [];
    if (aria && aria.name.length <= 120) {
        out.push(`role=${aria.role}[name=${quote(aria.name)}]`);
    }
    if (facts.label && facts.label.length <= 120) {
        out.push(`label=${quote(facts.label)}`);
    }
    if (facts.placeholder) out.push(`placeholder=${quote(facts.placeholder)}`);
    if (facts.testId) out.push(`data-testid=${facts.testId}`);
    if (!facts.isFormField && facts.text && facts.text.length <= 80) {
        out.push(`text=${quote(facts.text)}`);
    }
    if (isStableId(facts.id)) out.push(`css=#${facts.id}`);
    if (facts.isFormField && /^[\w.[\]-]+$/.test(facts.nameAttr)) {
        out.push(`css=${facts.tag}[name=${quote(facts.nameAttr)}]`);
    }
    out.push(`xpath=${facts.xpath}`);
    return out;
}

export type GeneratedSelectors = {
    selectors: MacroSelector[];
    facts: ElementFacts;
    /** `button "Sign in"`, for step titles and messages. */
    description: string;
};

/**
 * Ranked selectors for `handle`, generated from the element itself: role and
 * accessible name, label, placeholder, test id, visible text, a short CSS
 * selector, and an XPath last. Only selectors that resolve to exactly this
 * one element right now are kept; the absolute XPath always does.
 */
export async function generateSelectors(
    page: Page,
    handle: ElementHandle<Element>,
): Promise<GeneratedSelectors> {
    const facts = await readFacts(handle);
    const aria = await roleAndName(page.locator(`xpath=${facts.xpath}`));

    const kept: MacroSelector[] = [];
    for (const selector of candidateSelectors(facts, aria)) {
        try {
            const locator = locatorFor(page, selector);
            if ((await locator.count()) !== 1) continue;
            const same = await locator.evaluate(
                (el, target) => el === target,
                handle,
                { timeout: 2_000 },
            );
            if (same) kept.push(selector);
        } catch {
            // A selector the engine cannot parse is simply not kept.
        }
    }
    if (kept.length === 0) kept.push(`xpath=${facts.xpath}`);

    const what =
        aria ? `${aria.role} "${aria.name}"`
        : facts.label ? `${facts.tag} "${facts.label}"`
        : facts.text ? `${facts.tag} "${facts.text.slice(0, 60)}"`
        : facts.tag;
    return { selectors: kept, facts, description: what };
}
