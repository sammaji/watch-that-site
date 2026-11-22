import {
    SECRET_REF,
    type MacroSource,
    type MacroStep,
    type MacroStepType,
} from "@watchthatsite/types";

/** What each step type is called in the step list and the editor. */
export const STEP_TYPE_LABEL: Record<MacroStepType, string> = {
    navigate: "Open a page",
    click: "Click",
    fill: "Type",
    select: "Choose an option",
    press: "Press a key",
    scroll: "Scroll",
    wait_for: "Wait for something",
    wait: "Wait",
};

export const SOURCE_LABEL: Record<MacroSource, string> = {
    agent: "Recorded by the agent",
    user: "Edited by you",
    repair: "Repaired by the agent",
};

/** A step value with its secret references named instead of spelled out. */
export function displayValue(value: string): string {
    return value.replace(SECRET_REF, (_, name: string) => `‹secret ${name}›`);
}

/** The specifics of a step under its intent: what it acts on and with what. */
export function stepSpecifics(step: MacroStep): string {
    const target = "selectors" in step ? (step.selectors?.[0] ?? "") : "";
    switch (step.type) {
        case "navigate":
            return step.url;
        case "click":
            return target;
        case "fill":
            return `${displayValue(step.value) || "(empty)"} → ${target}`;
        case "select":
            return `“${step.value}” in ${target}`;
        case "press":
            return target ? `${step.key} in ${target}` : step.key;
        case "scroll":
            return (
                target ? `to ${target}`
                : step.y !== undefined ? `${step.y} px`
                : ""
            );
        case "wait_for":
            return step.text ? `the text “${step.text}”` : target;
        case "wait":
            return `${Math.round(step.ms / 100) / 10} s`;
    }
}
