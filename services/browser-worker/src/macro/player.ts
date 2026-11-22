import { describeStep, type MacroStep } from "@watchthatsite/types";
import type { Locator, Page } from "playwright-core";
import {
    defaultStepTimeoutMs,
    maxWaitStepMs,
    navigationTimeoutMs,
} from "../config/constants.js";
import { NetworkTracker, settle, sleep } from "../lib/stabilize.js";
import { SecretSession, type SecretReader } from "./secrets.js";
import { locatorFor } from "./selectors.js";

/**
 * The Macro player: runs Macro steps on a page with plain Playwright. No
 * model is involved; the same steps on the same page do the same thing.
 */

export type StepStatus = "ok" | "failed" | "skipped";

export interface StepResult {
    index: number;
    status: StepStatus;
    /** The selector that matched, when the step has selectors. */
    selector: string | null;
    /** Why the step failed or was skipped; "" when it ran. Never holds a secret. */
    error: string;
    durationMs: number;
}

export interface PlayResult {
    ok: boolean;
    /** Index of the step that failed, else null. */
    failedStep: number | null;
    /** A message a person can act on; "" when every step ran. */
    error: string;
    /** One entry per step that was reached, in order. */
    steps: StepResult[];
}

/** What one replay works with. Build it with `createPlayer`. */
export interface Player {
    page: Page;
    tracker: NetworkTracker;
    secrets: SecretSession;
    /**
     * Fields a secret was typed into that do not hide their value. Cover
     * them in any screenshot taken of this page.
     */
    sensitive: Locator[];
    signal?: AbortSignal;
}

export type StepHook = (event: {
    index: number;
    step: MacroStep;
    result: StepResult;
    player: Player;
}) => Promise<void>;

export function createPlayer(
    page: Page,
    readSecret: SecretReader,
    opts: { tracker?: NetworkTracker; signal?: AbortSignal } = {},
): Player {
    return {
        page,
        tracker: opts.tracker ?? new NetworkTracker(page),
        secrets: new SecretSession(readSecret),
        sensitive: [],
        ...(opts.signal ? { signal: opts.signal } : {}),
    };
}

/** "Step 3 (Open the Billing tab) could not be completed: no element matched". */
export function failureMessage(
    index: number,
    step: MacroStep,
    error: string,
): string {
    return `Step ${index + 1} (${describeStep(step)}) could not be completed: ${error}`;
}

/** The step could not find its element or condition in time. */
class NotFound extends Error {}

/** The first line of an error, without Playwright's call log, and without secrets. */
function cleanError(err: unknown, secrets: SecretSession): string {
    const raw =
        err instanceof Error ? err.message
        : typeof err === "string" ? err
        : "unknown error";
    const line = (raw.split("\n")[0] ?? "").trim() || "unknown error";
    // Playwright prefixes messages with the method it was in.
    return secrets.scrub(line.replace(/^(locator|page|keyboard)\.\w+: /, ""));
}

const selectorSyntax = /selector|engine|unexpected token|malformed|parsing/i;

/**
 * A selector that names an element by where it sits in the page and nothing
 * else: an absolute XPath of indexed steps, as the recorder adds last.
 */
const positional = /^(?:xpath=)?(?:\/[a-z][a-z0-9-]*\[\d+\])+$/i;

export function isPositional(selector: string): boolean {
    return positional.test(selector.trim());
}

/** What sits at a position now, for the message a person or the Agent reads. */
async function describeElement(locator: Locator): Promise<string> {
    return locator
        .evaluate(el => {
            const tag = el.tagName.toLowerCase();
            const label =
                el.getAttribute("aria-label") ||
                (el as HTMLElement).innerText ||
                el.getAttribute("placeholder") ||
                el.getAttribute("name") ||
                "";
            const words = label.replace(/\s+/g, " ").trim().slice(0, 60);
            return words ? `a ${tag} reading "${words}"` : `a ${tag}`;
        })
        .catch(() => "another element");
}

/**
 * Finds the element a step acts on: the first selector, in order, that
 * resolves to exactly one visible element before `deadline`.
 *
 * Every selector is polled until the deadline, but later ones join the race
 * one `stagger` apart. The most stable selector gets a head start (so a slow
 * page does not push the step onto a weaker selector), yet a selector that
 * no longer matches anything costs only its stagger, not the whole budget.
 *
 * A position alone is not trusted. When a step has selectors that name its
 * element (role, label, text, id) and none of them match, the element at the
 * recorded position may be the same control renamed, or a different control
 * that now sits there. Acting on it blind could press the wrong button in a
 * signed-in session, so the step fails and says what is at that position; the
 * Agent then looks at the page and repairs the step. A step that has only
 * positional selectors (written that way by hand) is taken at its word.
 */
async function resolveTarget(
    page: Page,
    selectors: string[],
    deadline: number,
): Promise<{ locator: Locator; selector: string }> {
    const start = Date.now();
    const budget = Math.max(0, deadline - start);
    const stagger = Math.min(750, budget / (2 * selectors.length));
    const counts = new Array<number>(selectors.length).fill(0);
    const broken = new Set<number>();
    const named = selectors.some(s => !isPositional(s));
    let displaced: Locator | null = null;

    for (;;) {
        const elapsed = Date.now() - start;
        displaced = null;
        for (let i = 0; i < selectors.length; i++) {
            if (elapsed < i * stagger) break;
            if (broken.has(i)) continue;
            try {
                const locator = locatorFor(page, selectors[i]!).filter({
                    visible: true,
                });
                const count = await locator.count();
                counts[i] = count;
                if (count !== 1) continue;
                if (named && isPositional(selectors[i]!)) {
                    // Keep waiting for a selector that names the element.
                    displaced ??= locator;
                    continue;
                }
                return { locator, selector: selectors[i]! };
            } catch (err) {
                // A selector that cannot be parsed never will be; anything
                // else (the page navigating under us) is worth another try.
                if (err instanceof Error && selectorSyntax.test(err.message)) {
                    broken.add(i);
                }
            }
        }
        if (Date.now() >= deadline) break;
        await sleep(100);
    }

    if (displaced) {
        throw new NotFound(
            `no element matched by name; where it used to be there is now ${await describeElement(displaced)}`,
        );
    }
    const ambiguous = counts.findIndex(c => c > 1);
    if (ambiguous >= 0 && counts.every(c => c !== 1)) {
        throw new NotFound(
            `${counts[ambiguous]} elements matched ${selectors[ambiguous]}, expected one`,
        );
    }
    throw new NotFound("no element matched");
}

function hasSelectors(
    step: MacroStep,
): step is MacroStep & { selectors: string[] } {
    return (
        "selectors" in step &&
        Array.isArray(step.selectors) &&
        step.selectors.length > 0
    );
}

/** Runs one step. Returns the selector that matched, if the step has any. */
async function execute(
    player: Player,
    step: MacroStep,
): Promise<string | null> {
    const { page, secrets } = player;
    const timeout =
        step.timeout_ms ??
        (step.type === "navigate" ? navigationTimeoutMs : defaultStepTimeoutMs);
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(500, deadline - Date.now());

    switch (step.type) {
        case "navigate": {
            let url: URL;
            try {
                url = new URL(step.url);
            } catch {
                throw new Error(`"${step.url}" is not a URL`);
            }
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("a navigate step may only open an http(s) URL");
            }
            await page.goto(url.toString(), {
                waitUntil: "domcontentloaded",
                timeout,
            });
            return null;
        }
        case "click": {
            const target = await resolveTarget(page, step.selectors, deadline);
            await target.locator.click({ timeout: remaining() });
            return target.selector;
        }
        case "fill": {
            const target = await resolveTarget(page, step.selectors, deadline);
            // The secret is read here, at the last moment, and goes nowhere
            // but into the field.
            const usesSecret = SecretSession.refs(step.value).length > 0;
            const value = await secrets.expand(step.value);
            await target.locator.fill(value, { timeout: remaining() });
            if (usesSecret) {
                const hidden = await target.locator
                    .evaluate(
                        el =>
                            el instanceof HTMLInputElement &&
                            el.type === "password",
                    )
                    .catch(() => false);
                if (!hidden) player.sensitive.push(target.locator);
            }
            return target.selector;
        }
        case "select": {
            const target = await resolveTarget(page, step.selectors, deadline);
            await target.locator.selectOption(step.value, {
                timeout: remaining(),
            });
            return target.selector;
        }
        case "press": {
            if (hasSelectors(step)) {
                const target = await resolveTarget(
                    page,
                    step.selectors,
                    deadline,
                );
                await target.locator.press(step.key, { timeout: remaining() });
                return target.selector;
            }
            await page.keyboard.press(step.key);
            return null;
        }
        case "scroll": {
            if (hasSelectors(step)) {
                const target = await resolveTarget(
                    page,
                    step.selectors,
                    deadline,
                );
                await target.locator.scrollIntoViewIfNeeded({
                    timeout: remaining(),
                });
                return target.selector;
            }
            await page.evaluate(
                y => window.scrollBy(0, y ?? window.innerHeight),
                step.y ?? null,
            );
            return null;
        }
        case "wait_for": {
            if (hasSelectors(step)) {
                const target = await resolveTarget(
                    page,
                    step.selectors,
                    deadline,
                );
                return target.selector;
            }
            if (!step.text) {
                throw new Error("a wait_for step needs selectors or text");
            }
            try {
                await page
                    .getByText(step.text)
                    .filter({ visible: true })
                    .first()
                    .waitFor({ state: "visible", timeout });
            } catch {
                throw new NotFound(`the text "${step.text}" did not appear`);
            }
            return null;
        }
        case "wait": {
            await sleep(Math.max(0, Math.min(step.ms, maxWaitStepMs)));
            return null;
        }
    }
}

/** Steps after which the page may be loading or re-rendering. */
const changesPage = new Set<MacroStep["type"]>([
    "navigate",
    "click",
    "press",
    "select",
]);

/**
 * Plays one step and waits for the page to settle. Never throws for a step
 * that fails: the result says what happened. An optional step whose element
 * (or awaited text) never shows up is `skipped`; any other problem, and any
 * problem on a step that is not optional, is `failed`.
 */
export async function playStep(
    player: Player,
    step: MacroStep,
    index: number,
): Promise<StepResult> {
    const started = Date.now();
    const done = (
        status: StepStatus,
        selector: string | null,
        error: string,
    ): StepResult => ({
        index,
        status,
        selector,
        error,
        durationMs: Date.now() - started,
    });

    if (player.signal?.aborted)
        return done("failed", null, "replay was cancelled");
    try {
        const selector = await execute(player, step);
        if (changesPage.has(step.type)) {
            await settle(player.page, player.tracker);
        }
        return done("ok", selector, "");
    } catch (err) {
        const message = cleanError(err, player.secrets);
        if (err instanceof NotFound && step.optional) {
            return done("skipped", null, message);
        }
        return done("failed", null, message);
    }
}

/**
 * Plays `steps` in order and stops at the first one that fails. `onStep`
 * runs after every step that was reached; the caller uses it to write the
 * trace and take a screenshot.
 */
export async function playMacro(
    player: Player,
    steps: MacroStep[],
    onStep?: StepHook,
): Promise<PlayResult> {
    const results: StepResult[] = [];
    for (let index = 0; index < steps.length; index++) {
        const step = steps[index]!;
        const result = await playStep(player, step, index);
        results.push(result);
        if (onStep) await onStep({ index, step, result, player });
        if (result.status === "failed") {
            return {
                ok: false,
                failedStep: index,
                error: failureMessage(index, step, result.error),
                steps: results,
            };
        }
    }
    return { ok: true, failedStep: null, error: "", steps: results };
}
