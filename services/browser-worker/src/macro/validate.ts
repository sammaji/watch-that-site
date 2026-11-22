import {
    MACRO_MAX_STEPS,
    MACRO_STEP_TYPES,
    type MacroStep,
    type MacroStepType,
} from "@watchthatsite/types";
import { maxWaitStepMs } from "../config/constants.js";

/** Steps that came from outside (the web app, a person's edit) and do not hold up. */
export class InvalidSteps extends Error {}

const maxSelectors = 12;
const maxTimeoutMs = 120_000;

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks Macro steps and returns them with only the fields a step has.
 * Throws InvalidSteps naming the step and what is wrong with it.
 */
export function parseSteps(value: unknown): MacroStep[] {
    if (!Array.isArray(value)) throw new InvalidSteps("steps must be an array");
    if (value.length === 0) throw new InvalidSteps("steps must not be empty");
    if (value.length > MACRO_MAX_STEPS) {
        throw new InvalidSteps(
            `a Macro may hold at most ${MACRO_MAX_STEPS} steps`,
        );
    }
    return value.map((raw, i) => {
        const at = `steps[${i}]`;
        const bad = (what: string): never => {
            throw new InvalidSteps(`${at}: ${what}`);
        };
        if (!isObject(raw)) return bad("must be an object");
        const type = raw.type as MacroStepType;
        if (!MACRO_STEP_TYPES.includes(type)) {
            return bad(`type must be one of ${MACRO_STEP_TYPES.join(", ")}`);
        }
        if (raw.intent !== undefined && typeof raw.intent !== "string") {
            bad("intent must be a string");
        }
        const base: {
            intent: string;
            timeout_ms?: number;
            optional?: boolean;
        } = {
            intent:
                typeof raw.intent === "string" ? raw.intent.slice(0, 300) : "",
        };
        if (raw.timeout_ms !== undefined) {
            const t = raw.timeout_ms;
            if (
                typeof t !== "number" ||
                !Number.isInteger(t) ||
                t < 0 ||
                t > maxTimeoutMs
            ) {
                bad(
                    `timeout_ms must be a whole number from 0 to ${maxTimeoutMs}`,
                );
            }
            base.timeout_ms = t as number;
        }
        if (raw.optional !== undefined) {
            if (typeof raw.optional !== "boolean")
                bad("optional must be true or false");
            if (raw.optional === true) base.optional = true;
        }

        const selectors = (required: boolean): string[] | undefined => {
            const list = raw.selectors;
            if (list === undefined || list === null) {
                return required ? bad("selectors are required") : undefined;
            }
            if (
                !Array.isArray(list) ||
                list.length > maxSelectors ||
                !list.every(
                    s =>
                        typeof s === "string" &&
                        s.trim() !== "" &&
                        s.length <= 1000,
                )
            ) {
                return bad(
                    `selectors must be up to ${maxSelectors} non-empty strings`,
                );
            }
            if (list.length === 0) {
                return required ?
                        bad("selectors must not be empty")
                    :   undefined;
            }
            return list as string[];
        };
        const str = (field: string, max = 4000): string => {
            const v = raw[field];
            if (typeof v !== "string" || v.length > max) {
                return bad(
                    `${field} must be a string of at most ${max} characters`,
                );
            }
            return v;
        };

        switch (type) {
            case "navigate": {
                const url = str("url", 2000);
                let parsed: URL | null = null;
                try {
                    parsed = new URL(url);
                } catch {
                    parsed = null;
                }
                if (
                    !parsed ||
                    (parsed.protocol !== "http:" &&
                        parsed.protocol !== "https:")
                ) {
                    bad("url must be an http(s) URL");
                }
                return { ...base, type, url };
            }
            case "click":
                return { ...base, type, selectors: selectors(true)! };
            case "fill":
            case "select":
                return {
                    ...base,
                    type,
                    selectors: selectors(true)!,
                    value: str("value"),
                };
            case "press": {
                const key = str("key", 40);
                if (key.trim() === "") bad("key must not be empty");
                const list = selectors(false);
                return {
                    ...base,
                    type,
                    key,
                    ...(list ? { selectors: list } : {}),
                };
            }
            case "scroll": {
                const list = selectors(false);
                if (
                    raw.y !== undefined &&
                    (typeof raw.y !== "number" || !Number.isFinite(raw.y))
                ) {
                    bad("y must be a number");
                }
                return {
                    ...base,
                    type,
                    ...(list ? { selectors: list } : {}),
                    ...(typeof raw.y === "number" ? { y: raw.y } : {}),
                };
            }
            case "wait_for": {
                const list = selectors(false);
                const waitText =
                    raw.text === undefined || raw.text === "" ?
                        undefined
                    :   str("text", 500);
                if (!list && !waitText) bad("needs selectors or text");
                return {
                    ...base,
                    type,
                    ...(list ? { selectors: list } : {}),
                    ...(waitText ? { text: waitText } : {}),
                };
            }
            case "wait": {
                const ms = raw.ms;
                if (
                    typeof ms !== "number" ||
                    !Number.isFinite(ms) ||
                    ms < 0 ||
                    ms > maxWaitStepMs
                ) {
                    bad(`ms must be a number from 0 to ${maxWaitStepMs}`);
                }
                return { ...base, type, ms: ms as number };
            }
        }
    });
}
