import { stepScreenshotKey, type MacroStep } from "@watchthatsite/types";
import type { Logger } from "pino";
import type { ElementHandle, Locator, Page } from "playwright-core";
import sharp from "sharp";
import { optionalStepTimeoutMs } from "../config/constants.js";
import type { NetworkTracker } from "../lib/stabilize.js";
import { settle } from "../lib/stabilize.js";
import { uploadStepScreenshot, viewportPng } from "../macro/screenshot.js";
import { MissingSecretError, SecretSession } from "../macro/secrets.js";
import {
    generateSelectors,
    type GeneratedSelectors,
} from "../macro/selectors.js";
import type { Trace } from "../store/trace.js";
import type { ObjectStore } from "../types.js";
import type { AgentTool, ToolOutcome } from "./loop.js";
import { clip, PageData } from "./page-data.js";
import type { SiteScope } from "./site-scope.js";
import { text, type ContentPart } from "./types.js";

/**
 * The browser the Agent drives while it records or repairs a Macro.
 *
 * The model sees the page as a `snapshot`: a compact list of what can be
 * acted on, each with a short ref, plus a screenshot. It acts by ref. For
 * every action that succeeds, this code reads ranked selectors off the
 * element itself and appends a Macro step; the model never writes a selector.
 */

const maxElements = 150;
const actionTimeoutMs = 8_000;

type SnapElement = {
    ref: number;
    role: string;
    name: string;
    placeholder: string;
    value: string;
    password: boolean;
    disabled: boolean;
    checked: boolean | null;
    offscreen: boolean;
    href: string;
    options: string[];
};

type SnapResult = {
    url: string;
    title: string;
    scrollY: number;
    viewportH: number;
    pageH: number;
    elements: SnapElement[];
    more: number;
};

/** Reads the page's interactive and landmark elements and remembers them by ref. */
async function readSnapshot(page: Page): Promise<SnapResult> {
    return page.evaluate((cap): SnapResult => {
        const collapse = (s: string | null | undefined) =>
            (s ?? "").replace(/\s+/g, " ").trim();
        const interactive = [
            "a[href]",
            "button",
            "input:not([type=hidden])",
            "select",
            "textarea",
            "summary",
            "[role=button]",
            "[role=link]",
            "[role=tab]",
            "[role=menuitem]",
            "[role=checkbox]",
            "[role=radio]",
            "[role=switch]",
            "[role=combobox]",
            "[role=option]",
            "[role=textbox]",
            "[role=searchbox]",
            "[contenteditable=true]",
            "[contenteditable='']",
            "[onclick]",
            "[tabindex]:not([tabindex='-1'])",
        ];
        const landmarks = [
            "h1",
            "h2",
            "h3",
            "[role=heading]",
            "dialog[open]",
            "[role=dialog]",
            "[role=alertdialog]",
            "[role=alert]",
            "[role=status]",
        ];
        const implicitRole = (el: Element): string => {
            const tag = el.tagName.toLowerCase();
            if (tag === "a") return "link";
            if (tag === "button" || tag === "summary") return "button";
            if (tag === "select") return "combobox";
            if (tag === "textarea") return "textbox";
            if (/^h[1-6]$/.test(tag)) return "heading";
            if (tag === "dialog") return "dialog";
            if (el instanceof HTMLInputElement) {
                if (el.type === "checkbox") return "checkbox";
                if (el.type === "radio") return "radio";
                if (["submit", "button", "reset", "image"].includes(el.type))
                    return "button";
                return "textbox";
            }
            return "";
        };
        const nameOf = (el: Element): string => {
            const aria = collapse(el.getAttribute("aria-label"));
            if (aria) return aria;
            const by = el.getAttribute("aria-labelledby");
            if (by) {
                const joined = collapse(
                    by
                        .split(/\s+/)
                        .map(
                            id =>
                                document.getElementById(id)?.textContent ?? "",
                        )
                        .join(" "),
                );
                if (joined) return joined;
            }
            if (
                el instanceof HTMLInputElement ||
                el instanceof HTMLTextAreaElement ||
                el instanceof HTMLSelectElement
            ) {
                const label = el.labels?.[0];
                if (label) return collapse(label.innerText);
                if (
                    el instanceof HTMLInputElement &&
                    ["submit", "button", "reset"].includes(el.type)
                ) {
                    return collapse(el.value);
                }
                return collapse(el.getAttribute("title"));
            }
            const own = collapse(
                el instanceof HTMLElement ? el.innerText : el.textContent,
            );
            if (own) return own;
            const img = el.querySelector("img[alt]");
            return (
                collapse(img?.getAttribute("alt")) ||
                collapse(el.getAttribute("title"))
            );
        };

        const refs: Element[] = [];
        (window as unknown as { __wtsRefs: Element[] }).__wtsRefs = refs;
        const elements: SnapElement[] = [];
        let more = 0;
        const all = document.querySelectorAll(
            [...interactive, ...landmarks].join(","),
        );
        for (const el of all) {
            if (el.closest("[aria-hidden=true]")) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const style = getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none")
                continue;
            if (elements.length >= cap) {
                more++;
                continue;
            }
            const input =
                (
                    el instanceof HTMLInputElement ||
                    el instanceof HTMLTextAreaElement
                ) ?
                    el
                :   null;
            const password =
                el instanceof HTMLInputElement && el.type === "password";
            const link = el instanceof HTMLAnchorElement ? el : null;
            let href = "";
            if (link) {
                try {
                    const u = new URL(link.href);
                    href =
                        u.origin === location.origin ?
                            u.pathname + u.search
                        :   u.href;
                } catch {
                    href = "";
                }
            }
            refs.push(el);
            elements.push({
                ref: refs.length - 1,
                role:
                    collapse(el.getAttribute("role")) ||
                    implicitRole(el) ||
                    el.tagName.toLowerCase(),
                name: nameOf(el).slice(0, 100),
                placeholder: collapse(el.getAttribute("placeholder")).slice(
                    0,
                    60,
                ),
                // A password's value never leaves the page.
                value:
                    input && !password ?
                        collapse(input.value).slice(0, 80)
                    :   "",
                password,
                disabled:
                    (el as HTMLButtonElement).disabled === true ||
                    el.getAttribute("aria-disabled") === "true",
                checked:
                    (
                        el instanceof HTMLInputElement &&
                        (el.type === "checkbox" || el.type === "radio")
                    ) ?
                        el.checked
                    : el.getAttribute("aria-checked") !== null ?
                        el.getAttribute("aria-checked") === "true"
                    : el.getAttribute("aria-selected") === "true" ? true
                    : null,
                offscreen: rect.bottom < 0 || rect.top > window.innerHeight,
                href: href.slice(0, 100),
                options:
                    el instanceof HTMLSelectElement ?
                        [...el.options]
                            .slice(0, 12)
                            .map(
                                o =>
                                    `${collapse(o.label)}${o.selected ? " (selected)" : ""}`,
                            )
                    :   [],
            });
        }
        const doc = document.documentElement;
        return {
            url: location.href,
            title: document.title,
            scrollY: Math.round(window.scrollY),
            viewportH: window.innerHeight,
            pageH: Math.max(doc.scrollHeight, doc.clientHeight),
            elements,
            more,
        };
    }, maxElements);
}

function elementLine(el: SnapElement): string {
    const bits = [`[e${el.ref}] ${el.role}${el.name ? ` "${el.name}"` : ""}`];
    if (el.password) bits.push("(password field)");
    if (el.placeholder) bits.push(`placeholder="${el.placeholder}"`);
    if (el.value) bits.push(`value="${el.value}"`);
    if (el.options.length > 0) bits.push(`options: ${el.options.join(" | ")}`);
    if (el.checked !== null) bits.push(el.checked ? "(on)" : "(off)");
    if (el.href) bits.push(`→ ${el.href}`);
    if (el.disabled) bits.push("(disabled)");
    if (el.offscreen) bits.push("(outside the viewport)");
    return bits.join(" ");
}

export interface BrowserSessionOptions {
    page: Page;
    tracker: NetworkTracker;
    secrets: SecretSession;
    /** Names of the Monitor's secrets; the model may type only these. */
    secretNames: string[];
    scope: SiteScope;
    pageData: PageData;
    trace: Trace;
    monitorId: string;
    objectStore: ObjectStore | null;
    logger: Logger;
    /** Actions the Agent may take; past it only the terminal tools work. */
    maxActions: number;
    /** Fields already holding a typed secret (from a replay this session continues). */
    sensitive?: Locator[];
}

const intentParam = {
    type: "string" as const,
    description:
        'Why you take this action, in plain words for the owner. It becomes the Macro step\'s description: "Open the Billing tab".',
};
const refParam = {
    type: "string" as const,
    description:
        'The ref of an element from the latest snapshot, such as "e12".',
};

export class BrowserSession {
    /** The Macro steps of the actions taken so far, in order. */
    readonly steps: MacroStep[] = [];
    /** Fields a secret was typed into that show their value; screenshots cover them. */
    readonly sensitive: Locator[];
    private actions = 0;
    private closedPopups = 0;
    private readonly onPopup: (popup: Page) => void;

    constructor(private readonly o: BrowserSessionOptions) {
        this.sensitive = o.sensitive ?? [];
        // One page per session: a new tab would leave the Macro player, which
        // replays on a single page, unable to follow.
        this.onPopup = popup => {
            if (popup === o.page) return;
            this.closedPopups++;
            void popup.close().catch(() => undefined);
        };
        o.page.context().on("page", this.onPopup);
    }

    /** How many actions have been taken. */
    get actionCount(): number {
        return this.actions;
    }

    get page(): Page {
        return this.o.page;
    }

    /** The page as text for the model: where it is and what can be acted on. */
    async describePage(): Promise<string> {
        const snap = await readSnapshot(this.o.page);
        const lines = [
            `URL: ${snap.url}`,
            `Title: ${clip(snap.title, 120)}`,
            `Showing page y ${snap.scrollY} to ${snap.scrollY + snap.viewportH} of ${snap.pageH}.`,
            ...snap.elements.map(elementLine),
        ];
        if (snap.more > 0) {
            lines.push(
                `… ${snap.more} more elements further down are not listed.`,
            );
        }
        // Whatever the page echoes back (a value in a field, a greeting with
        // the account name) goes through the scrubber before a model sees it.
        return this.o.pageData.wrap(
            "page",
            this.o.secrets.scrub(lines.join("\n")),
        );
    }

    /** A viewport screenshot for the model, with secret-holding fields covered. */
    async screenshotPart(): Promise<ContentPart | null> {
        try {
            const png = await viewportPng(this.o.page, this.sensitive);
            return {
                type: "image",
                mediaType: "image/jpeg",
                data: await sharp(png).jpeg({ quality: 75 }).toBuffer(),
            };
        } catch {
            return null;
        }
    }

    /** Text and a screenshot of the page as it is now. */
    async snapshot(): Promise<ContentPart[]> {
        const parts: ContentPart[] = [text(await this.describePage())];
        const shot = await this.screenshotPart();
        if (shot) parts.push(text("The viewport:"), shot);
        return parts;
    }

    /** Forgets the refs the page holds, so nothing of ours is left on it. */
    async cleanup(): Promise<void> {
        this.o.page.context().off("page", this.onPopup);
        await this.o.page
            .evaluate(() => {
                delete (window as unknown as { __wtsRefs?: unknown }).__wtsRefs;
            })
            .catch(() => undefined);
    }

    private async elementFor(ref: unknown): Promise<ElementHandle<Element>> {
        const m = /^e?(\d+)$/.exec(String(ref).trim());
        if (!m)
            throw new ActionError(
                `"${String(ref)}" is not a ref. Refs look like e12.`,
            );
        const handle = await this.o.page.evaluateHandle(i => {
            const el = (window as unknown as { __wtsRefs?: Element[] })
                .__wtsRefs?.[i];
            return el && el.isConnected ? el : null;
        }, Number(m[1]));
        const element = handle.asElement();
        if (!element) {
            throw new ActionError(
                `e${m[1]} is not on the page any more: the page changed since that snapshot. Use the refs of the latest page listing.`,
            );
        }
        return element as ElementHandle<Element>;
    }

    /**
     * An action that did not happen. The page listing goes back with the
     * reason, so the model's next try uses refs that are certainly current.
     */
    private async fail<R>(
        message: string,
        intent: unknown,
    ): Promise<ToolOutcome<R>> {
        const listing = await this.describePage().catch(() => "");
        return {
            content: [
                text(
                    `${this.o.secrets.scrub(message)}${listing ? `\nThe page now:\n${listing}` : ""}`,
                ),
            ],
            isError: true,
            title:
                typeof intent === "string" && intent ?
                    `Tried: ${clip(intent, 120)}`
                :   null,
            detail: { error: clip(this.o.secrets.scrub(message), 300) },
        };
    }

    /**
     * Runs one action. `perform` does it and returns the Macro step that
     * repeats it; a step is recorded only when the action succeeded.
     */
    private async act<R>(
        kind: string,
        input: Record<string, unknown>,
        perform: () => Promise<{ step: MacroStep; did: string }>,
    ): Promise<ToolOutcome<R>> {
        const intent = String(input.intent ?? "").trim();
        if (this.actions >= this.o.maxActions) {
            return this.fail(
                this.o.maxActions === 1 ?
                    "You have taken your one action. Call done if it completed the step, or fail and say what is in the way."
                :   `You have used all ${this.o.maxActions} actions. Call done if the goal is reached, or fail and say what is left.`,
                null,
            );
        }
        let step: MacroStep;
        let did: string;
        try {
            ({ step, did } = await perform());
        } catch (err) {
            const message =
                (
                    err instanceof ActionError ||
                    err instanceof MissingSecretError
                ) ?
                    err.message
                : err instanceof Error ?
                    (err.message.split("\n")[0] ?? "the action failed")
                :   "the action failed";
            return this.fail(`${kind} did not work: ${message}`, intent);
        }
        this.actions++;
        this.steps.push(step);
        await settle(this.o.page, this.o.tracker);
        // Wherever the site took the browser is now somewhere the Agent may be.
        this.o.scope.landedOn(this.o.page.url());

        const seq = this.o.trace.reserve();
        const screenshotKey = await uploadStepScreenshot(
            this.o.page,
            this.o.objectStore,
            stepScreenshotKey(this.o.monitorId, this.o.trace.subjectId, seq),
            this.sensitive,
            this.o.logger,
        );
        const notes: string[] = [`Done: ${did}.`];
        if (this.closedPopups > 0) {
            notes.push(
                "The action opened a new tab, which is not supported; it was closed.",
            );
            this.closedPopups = 0;
        }
        const left = this.o.maxActions - this.actions;
        if (left === 0)
            notes.push("That was your last action: call done or fail now.");
        else if (left <= 3)
            notes.push(`${left} action${left === 1 ? "" : "s"} left.`);
        return {
            content: [
                text(
                    `${notes.join(" ")}\nThe page now:\n${await this.describePage()}`,
                ),
            ],
            title: intent || did,
            detail: {
                step: step.type,
                ...("selectors" in step && step.selectors?.[0] ?
                    { selector: step.selectors[0] }
                :   {}),
                ...(step.optional ? { optional: true } : {}),
                url: this.o.page.url(),
            },
            screenshotKey,
            traceSeq: seq,
        };
    }

    /** Sign-in fields and cookie-banner buttons are absent on a signed-in Run: their steps may be skipped. */
    private optionalFor(gen: GeneratedSelectors, usesSecret = false) {
        return gen.facts.signIn || gen.facts.cookieBanner || usesSecret ?
                { optional: true as const, timeout_ms: optionalStepTimeoutMs }
            :   {};
    }

    private checkLeaves(gen: GeneratedSelectors, submits: boolean): void {
        const { href, formAction } = gen.facts;
        if (href && !/^javascript:/i.test(href) && !this.o.scope.allows(href)) {
            throw new ActionError(this.o.scope.refusal(href));
        }
        if (submits && formAction && !this.o.scope.allows(formAction)) {
            throw new ActionError(this.o.scope.refusal(formAction));
        }
    }

    /** The browser tools: `snapshot` and one tool per kind of action. */
    tools<R>(): AgentTool<R>[] {
        const page = this.o.page;
        const obj = (
            properties: Record<string, object>,
            required: string[],
        ) => ({
            type: "object" as const,
            properties: properties as never,
            required,
            additionalProperties: false,
        });

        return [
            {
                def: {
                    name: "snapshot",
                    description:
                        "Shows the page as it is now: its URL, the elements you can act on (each with a ref), and a screenshot of the viewport. Every action also returns the new element list, so call this when you need to see the page.",
                    inputSchema: obj({}, []),
                },
                run: async () => ({
                    content: await this.snapshot(),
                    title: null,
                }),
            },
            {
                def: {
                    name: "click",
                    description: "Clicks an element.",
                    inputSchema: obj({ ref: refParam, intent: intentParam }, [
                        "ref",
                        "intent",
                    ]),
                },
                run: input =>
                    this.act("click", input, async () => {
                        const el = await this.elementFor(input.ref);
                        const gen = await generateSelectors(page, el);
                        this.checkLeaves(gen, true);
                        await el.click({ timeout: actionTimeoutMs });
                        return {
                            step: {
                                type: "click",
                                intent: String(input.intent).trim(),
                                selectors: gen.selectors,
                                ...this.optionalFor(gen),
                            },
                            did: `clicked ${gen.description}`,
                        };
                    }),
            },
            {
                def: {
                    name: "fill",
                    description:
                        "Types a value into a field, replacing what is there. For a credential, give the secret's placeholder exactly, such as {{secret:password}}; the value is filled in for you and you never see it.",
                    inputSchema: obj(
                        {
                            ref: refParam,
                            value: {
                                type: "string",
                                description:
                                    "The text to type, or a {{secret:name}} placeholder.",
                            },
                            intent: intentParam,
                        },
                        ["ref", "value", "intent"],
                    ),
                },
                run: input =>
                    this.act("fill", input, async () => {
                        const value = String(input.value);
                        const names = SecretSession.refs(value);
                        const unknown = names.filter(
                            n => !this.o.secretNames.includes(n),
                        );
                        if (unknown.length > 0) {
                            throw new ActionError(
                                `There is no secret named ${unknown.map(n => `"${n}"`).join(", ")}. This Monitor's secrets are: ${this.o.secretNames.join(", ") || "(none)"}. If the goal needs a credential that is not among them, call fail and name what is missing.`,
                            );
                        }
                        const el = await this.elementFor(input.ref);
                        const gen = await generateSelectors(page, el);
                        if (gen.facts.isPassword && names.length === 0) {
                            throw new ActionError(
                                `A password is typed as a secret placeholder, never literally. This Monitor's secrets are: ${this.o.secretNames.join(", ") || "(none)"}. If none fits, call fail and name what is missing.`,
                            );
                        }
                        await el.fill(await this.o.secrets.expand(value), {
                            timeout: actionTimeoutMs,
                        });
                        if (names.length > 0 && !gen.facts.isPassword) {
                            this.sensitive.push(
                                page.locator(`xpath=${gen.facts.xpath}`),
                            );
                        }
                        return {
                            step: {
                                type: "fill",
                                intent: String(input.intent).trim(),
                                selectors: gen.selectors,
                                value,
                                ...this.optionalFor(gen, names.length > 0),
                            },
                            did: `typed ${names.length > 0 ? "the secret" : `"${clip(value, 60)}"`} into ${gen.description}`,
                        };
                    }),
            },
            {
                def: {
                    name: "select",
                    description:
                        "Chooses an option of a dropdown (a select element), by its label or value.",
                    inputSchema: obj(
                        {
                            ref: refParam,
                            value: {
                                type: "string",
                                description: "The option's label or value.",
                            },
                            intent: intentParam,
                        },
                        ["ref", "value", "intent"],
                    ),
                },
                run: input =>
                    this.act("select", input, async () => {
                        const el = await this.elementFor(input.ref);
                        const gen = await generateSelectors(page, el);
                        await el.selectOption(String(input.value), {
                            timeout: actionTimeoutMs,
                        });
                        return {
                            step: {
                                type: "select",
                                intent: String(input.intent).trim(),
                                selectors: gen.selectors,
                                value: String(input.value),
                                ...this.optionalFor(gen),
                            },
                            did: `chose "${clip(String(input.value), 60)}" in ${gen.description}`,
                        };
                    }),
            },
            {
                def: {
                    name: "press",
                    description:
                        'Presses a key, such as "Enter", "Escape" or "Tab": in an element when a ref is given, otherwise on the page.',
                    inputSchema: obj(
                        {
                            key: {
                                type: "string",
                                description:
                                    "A key name as Playwright spells it.",
                            },
                            ref: refParam,
                            intent: intentParam,
                        },
                        ["key", "intent"],
                    ),
                },
                run: input =>
                    this.act("press", input, async () => {
                        const key = String(input.key);
                        const intent = String(input.intent).trim();
                        if (
                            input.ref === undefined ||
                            input.ref === null ||
                            input.ref === ""
                        ) {
                            await page.keyboard.press(key);
                            return {
                                step: { type: "press", intent, key },
                                did: `pressed ${key}`,
                            };
                        }
                        const el = await this.elementFor(input.ref);
                        const gen = await generateSelectors(page, el);
                        this.checkLeaves(gen, key === "Enter");
                        await el.press(key, { timeout: actionTimeoutMs });
                        return {
                            step: {
                                type: "press",
                                intent,
                                key,
                                selectors: gen.selectors,
                                ...this.optionalFor(gen),
                            },
                            did: `pressed ${key} in ${gen.description}`,
                        };
                    }),
            },
            {
                def: {
                    name: "scroll",
                    description:
                        "Scrolls an element into view when a ref is given, otherwise the page by y pixels (negative scrolls up; default one viewport down).",
                    inputSchema: obj(
                        {
                            ref: refParam,
                            y: {
                                type: "integer",
                                description: "Pixels to scroll the page by.",
                            },
                            intent: intentParam,
                        },
                        ["intent"],
                    ),
                },
                run: input =>
                    this.act("scroll", input, async () => {
                        const intent = String(input.intent).trim();
                        if (
                            input.ref !== undefined &&
                            input.ref !== null &&
                            input.ref !== ""
                        ) {
                            const el = await this.elementFor(input.ref);
                            const gen = await generateSelectors(page, el);
                            await el.scrollIntoViewIfNeeded({
                                timeout: actionTimeoutMs,
                            });
                            return {
                                step: {
                                    type: "scroll",
                                    intent,
                                    selectors: gen.selectors,
                                },
                                did: `scrolled to ${gen.description}`,
                            };
                        }
                        const y = typeof input.y === "number" ? input.y : null;
                        await page.evaluate(
                            by => window.scrollBy(0, by ?? window.innerHeight),
                            y,
                        );
                        return {
                            step: {
                                type: "scroll",
                                intent,
                                ...(y !== null ? { y } : {}),
                            },
                            did: "scrolled the page",
                        };
                    }),
            },
            {
                def: {
                    name: "wait_for",
                    description:
                        "Waits until some text is visible on the page, for content that loads after an action.",
                    inputSchema: obj(
                        {
                            text: {
                                type: "string",
                                description:
                                    "Text that will be on the page once it is ready.",
                            },
                            intent: intentParam,
                        },
                        ["text", "intent"],
                    ),
                },
                run: input =>
                    this.act("wait_for", input, async () => {
                        const wanted = String(input.text);
                        try {
                            await page
                                .getByText(wanted)
                                .filter({ visible: true })
                                .first()
                                .waitFor({ state: "visible", timeout: 10_000 });
                        } catch {
                            throw new ActionError(
                                `the text "${clip(wanted, 60)}" did not appear within 10 seconds`,
                            );
                        }
                        return {
                            step: {
                                type: "wait_for",
                                intent: String(input.intent).trim(),
                                text: wanted,
                            },
                            did: `waited for "${clip(wanted, 60)}"`,
                        };
                    }),
            },
            {
                def: {
                    name: "navigate",
                    description:
                        "Opens a URL on the Monitor's own site. Prefer clicking through the page as a person would; use this when there is no link to click.",
                    inputSchema: obj(
                        {
                            url: {
                                type: "string",
                                description:
                                    "An absolute URL, or a path on the current site.",
                            },
                            intent: intentParam,
                        },
                        ["url", "intent"],
                    ),
                },
                run: input =>
                    this.act("navigate", input, async () => {
                        let url: string;
                        try {
                            url = new URL(
                                String(input.url),
                                page.url(),
                            ).toString();
                        } catch {
                            throw new ActionError(
                                `"${clip(String(input.url), 80)}" is not a URL`,
                            );
                        }
                        if (!this.o.scope.allows(url)) {
                            throw new ActionError(this.o.scope.refusal(url));
                        }
                        await page.goto(url, {
                            waitUntil: "domcontentloaded",
                            timeout: 30_000,
                        });
                        // A URL the Agent chose must not widen where it may
                        // go: if it redirected off the site, step back.
                        const landed = page.url();
                        if (!this.o.scope.allows(landed)) {
                            await page
                                .goBack({ waitUntil: "domcontentloaded" })
                                .catch(() => undefined);
                            throw new ActionError(this.o.scope.refusal(landed));
                        }
                        return {
                            step: {
                                type: "navigate",
                                intent: String(input.intent).trim(),
                                url,
                            },
                            did: `opened ${url}`,
                        };
                    }),
            },
        ];
    }
}

/** A problem with an action that the model can fix by acting differently. */
class ActionError extends Error {}
