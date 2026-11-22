/**
 * A Macro: the ordered browser actions replayed before each Capture, so the
 * page is in the state the owner wants watched (signed in, a tab opened, a
 * filter applied).
 *
 * Stored in `macros.steps`. The browser worker's player
 * (services/browser-worker/src/macro/player.ts) is the only thing that runs
 * these; the agent produces them when it records or repairs a Macro, and the
 * web app lets the owner edit them.
 */

/**
 * A Playwright selector string. Each step lists several, most stable first;
 * the player uses the first one that matches exactly one visible element.
 *
 * Preferred order when recording: role and accessible name
 * (`role=button[name="Sign in"]`), label or placeholder
 * (`label=Email`, `placeholder=Search`), test id (`data-testid=...`), visible
 * text (`text=Annual`), a short CSS selector (`css=#plan-toggle`), and an
 * XPath last (`xpath=//form//input[@type="password"]`).
 */
export type MacroSelector = string;

interface StepBase {
    /** Why the step exists, in plain words. The repair agent reads this. */
    intent: string;
    /** How long to wait for the element or condition. Default 10 000. */
    timeout_ms?: number;
    /**
     * Skip the step instead of failing when its element never appears. Used
     * for sign-in fields (absent when the saved session is still valid) and
     * cookie banners.
     */
    optional?: boolean;
}

export type MacroStep =
    | (StepBase & { type: "navigate"; url: string })
    | (StepBase & { type: "click"; selectors: MacroSelector[] })
    /** `value` may contain `{{secret:<name>}}`, resolved by the player. */
    | (StepBase & { type: "fill"; selectors: MacroSelector[]; value: string })
    | (StepBase & { type: "select"; selectors: MacroSelector[]; value: string })
    | (StepBase & { type: "press"; key: string; selectors?: MacroSelector[] })
    /** Scroll an element into view, or the page by `y` CSS pixels. */
    | (StepBase & { type: "scroll"; selectors?: MacroSelector[]; y?: number })
    /** Wait for an element to be visible, or for text to appear on the page. */
    | (StepBase & {
          type: "wait_for";
          selectors?: MacroSelector[];
          text?: string;
      })
    | (StepBase & { type: "wait"; ms: number });

export type MacroStepType = MacroStep["type"];

export const MACRO_STEP_TYPES: MacroStepType[] = [
    "navigate",
    "click",
    "fill",
    "select",
    "press",
    "scroll",
    "wait_for",
    "wait",
];

/** Most steps a Macro may hold. */
export const MACRO_MAX_STEPS = 40;

export type MacroStatus =
    "recording" | "draft" | "active" | "archived" | "failed";

export type MacroSource = "agent" | "user" | "repair";

/** A `macros` row. */
export interface Macro {
    id: string;
    monitor_id: string;
    version: number;
    status: MacroStatus;
    source: MacroSource;
    goal: string;
    steps: MacroStep[];
    note: string;
    created_at: string;
    updated_at: string;
}

/** Matches `{{secret:name}}` in a fill value. */
export const SECRET_REF = /\{\{secret:([a-z][a-z0-9_]{0,39})\}\}/g;

/** The secret names a Macro's steps refer to. */
export function secretNames(steps: MacroStep[]): string[] {
    const names = new Set<string>();
    for (const step of steps) {
        if (step.type !== "fill") continue;
        for (const m of step.value.matchAll(SECRET_REF)) names.add(m[1]!);
    }
    return [...names];
}

/** One line describing a step, for step lists and the Run trace. */
export function describeStep(step: MacroStep): string {
    if (step.intent.trim() !== "") return step.intent.trim();
    switch (step.type) {
        case "navigate":
            return `Open ${step.url}`;
        case "click":
            return "Click an element";
        case "fill":
            return "Type into a field";
        case "select":
            return `Choose "${step.value}"`;
        case "press":
            return `Press ${step.key}`;
        case "scroll":
            return "Scroll";
        case "wait_for":
            return step.text ?
                    `Wait for "${step.text}"`
                :   "Wait for an element";
        case "wait":
            return `Wait ${Math.round(step.ms / 100) / 10} s`;
    }
}

export type RunStepPhase = "macro" | "repair" | "record" | "plan" | "compare";

export type RunStepStatus = "ok" | "failed" | "repaired" | "skipped";

/** A `run_steps` row: one thing that happened during a Run or a recording. */
export interface RunStep {
    id: string;
    run_id: string | null;
    macro_id: string | null;
    monitor_id: string;
    seq: number;
    phase: RunStepPhase;
    /** The Macro step type or the agent tool name. */
    kind: string;
    title: string;
    status: RunStepStatus;
    detail: Record<string, unknown>;
    screenshot_key: string | null;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    created_at: string;
}
