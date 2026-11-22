import {
    MACRO_MAX_STEPS,
    MACRO_STEP_TYPES,
    type MacroStep,
    type MacroStepType,
} from "@watchthatsite/types";

/**
 * Checks Macro steps against the `MacroStep` shapes
 * (packages/types/src/macro.ts). The step editor runs it before saving and
 * the server actions run it again on whatever the browser sends, so both
 * report the same problems in the same words.
 */

export const SECRET_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** `{{secret:name}}`, as a step value refers to a saved secret. */
export function secretRef(name: string): string {
    return `{{secret:${name}}}`;
}

const MAX_SELECTORS = 12;
const MAX_SELECTOR_LENGTH = 600;
const MAX_TEXT_LENGTH = 2_000;
const MAX_INTENT_LENGTH = 300;
const MAX_WAIT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;

export type StepsResult =
    | { ok: true; steps: MacroStep[] }
    | { ok: false; error: string; step: number | null };

class StepError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(
    value: unknown,
    what: string,
    { required = true, max = MAX_TEXT_LENGTH } = {},
): string {
    if (value === undefined || value === null) {
        if (required) throw new StepError(`needs ${what}.`);
        return "";
    }
    if (typeof value !== "string") throw new StepError(`needs ${what}.`);
    if (required && value.trim() === "") throw new StepError(`needs ${what}.`);
    if (value.length > max) {
        throw new StepError(`has ${what} longer than ${max} characters.`);
    }
    return value;
}

function selectors(value: unknown, required: boolean): string[] | undefined {
    if (value === undefined || value === null) {
        if (required) throw new StepError("needs at least one selector.");
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new StepError("needs its selectors as a list.");
    }
    const list = value.map(item => {
        if (typeof item !== "string") {
            throw new StepError("has a selector that is not text.");
        }
        return item.trim();
    });
    const kept = list.filter(item => item !== "");
    if (kept.length === 0) {
        if (required) throw new StepError("needs at least one selector.");
        return undefined;
    }
    if (kept.length > MAX_SELECTORS) {
        throw new StepError(`has more than ${MAX_SELECTORS} selectors.`);
    }
    if (kept.some(item => item.length > MAX_SELECTOR_LENGTH)) {
        throw new StepError(
            `has a selector longer than ${MAX_SELECTOR_LENGTH} characters.`,
        );
    }
    return kept;
}

function wholeNumber(
    value: unknown,
    what: string,
    min: number,
    max: number,
): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new StepError(`needs ${what} as a number.`);
    }
    const rounded = Math.round(value);
    if (rounded < min || rounded > max) {
        throw new StepError(`needs ${what} between ${min} and ${max}.`);
    }
    return rounded;
}

function httpUrl(value: unknown): string {
    const url = text(value, "a URL").trim();
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new StepError("needs a full URL, starting with https://.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new StepError("needs an http or https URL.");
    }
    return url;
}

/** Returns the step with only the fields its type has, or throws. */
function cleanStep(raw: unknown): MacroStep {
    if (!isRecord(raw)) throw new StepError("is not a step.");
    const type = raw.type as MacroStepType;
    if (!MACRO_STEP_TYPES.includes(type)) {
        throw new StepError("has a type the player does not know.");
    }

    const base: { intent: string; timeout_ms?: number; optional?: true } = {
        // The repair agent reads the intent to find the element again, so a
        // step without one cannot be repaired.
        intent: text(raw.intent, "a line saying what it is for", {
            max: MAX_INTENT_LENGTH,
        }).trim(),
    };
    if (raw.timeout_ms !== undefined && raw.timeout_ms !== null) {
        base.timeout_ms = wholeNumber(
            raw.timeout_ms,
            "a timeout",
            100,
            MAX_TIMEOUT_MS,
        );
    }
    if (raw.optional === true) base.optional = true;

    switch (type) {
        case "navigate":
            return { ...base, type, url: httpUrl(raw.url) };
        case "click":
            return {
                ...base,
                type,
                selectors: selectors(raw.selectors, true)!,
            };
        case "fill":
            return {
                ...base,
                type,
                selectors: selectors(raw.selectors, true)!,
                value: text(raw.value, "the text to type", {
                    required: false,
                }),
            };
        case "select":
            return {
                ...base,
                type,
                selectors: selectors(raw.selectors, true)!,
                value: text(raw.value, "the option to choose"),
            };
        case "press": {
            const sel = selectors(raw.selectors, false);
            return {
                ...base,
                type,
                key: text(raw.key, "a key, such as Enter", { max: 40 }).trim(),
                ...(sel ? { selectors: sel } : {}),
            };
        }
        case "scroll": {
            const sel = selectors(raw.selectors, false);
            const hasY = raw.y !== undefined && raw.y !== null;
            if (!sel && !hasY) {
                throw new StepError(
                    "needs a selector to scroll to, or a distance in pixels.",
                );
            }
            return {
                ...base,
                type,
                ...(sel ? { selectors: sel } : {}),
                ...(hasY ?
                    { y: wholeNumber(raw.y, "a distance", -100_000, 100_000) }
                :   {}),
            };
        }
        case "wait_for": {
            const sel = selectors(raw.selectors, false);
            const waitText = text(raw.text, "the text to wait for", {
                required: false,
            }).trim();
            if (!sel && waitText === "") {
                throw new StepError(
                    "needs a selector or some text to wait for.",
                );
            }
            return {
                ...base,
                type,
                ...(sel ? { selectors: sel } : {}),
                ...(waitText ? { text: waitText } : {}),
            };
        }
        case "wait":
            return {
                ...base,
                type,
                ms: wholeNumber(raw.ms, "a wait", 0, MAX_WAIT_MS),
            };
    }
}

/** Validates and normalizes a list of steps. */
export function checkSteps(input: unknown): StepsResult {
    if (!Array.isArray(input)) {
        return { ok: false, error: "The steps are not a list.", step: null };
    }
    if (input.length === 0) {
        return {
            ok: false,
            error: "Pre-scraping needs at least one step.",
            step: null,
        };
    }
    if (input.length > MACRO_MAX_STEPS) {
        return {
            ok: false,
            error: `Pre-scraping can have at most ${MACRO_MAX_STEPS} steps; this one has ${input.length}.`,
            step: null,
        };
    }
    const steps: MacroStep[] = [];
    for (let i = 0; i < input.length; i++) {
        try {
            steps.push(cleanStep(input[i]));
        } catch (error) {
            if (!(error instanceof StepError)) throw error;
            return {
                ok: false,
                error: `Step ${i + 1} ${error.message}`,
                step: i,
            };
        }
    }
    return { ok: true, steps };
}
