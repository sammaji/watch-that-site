"use client";

import { ObjectImage } from "@/components/change/object-image";
import { formatDuration } from "@/components/monitor/format";
import { testSteps } from "@/hooks/use-macros";
import { checkSteps, secretRef } from "@/lib/macro";
import {
    MACRO_MAX_STEPS,
    MACRO_STEP_TYPES,
    secretNames,
    type MacroStep,
    type MacroStepType,
    type TestMacroResponse,
} from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import { Checkbox } from "@watchthatsite/ui/components/checkbox";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { Textarea } from "@watchthatsite/ui/components/textarea";
import { cn } from "@watchthatsite/ui/lib/utils";
import {
    ArrowDown,
    ArrowUp,
    CircleAlert,
    CircleCheck,
    CircleSlash,
    FlaskConical,
    Plus,
    Trash2,
} from "lucide-react";
import React from "react";
import { STEP_TYPE_LABEL } from "./step-format";

/**
 * Edit a Macro's steps by hand: add, remove, reorder, and change each step's
 * type, intent, selectors, value and key. "Test these steps" replays the
 * edited steps once through the agent API (no model) and marks each one
 * passed, failed or skipped.
 */

/** One step while it is being edited: every field as the inputs hold it. */
type Draft = {
    id: string;
    type: MacroStepType;
    intent: string;
    optional: boolean;
    /** Kept as it was; the editor has no field for it. */
    timeoutMs: number | undefined;
    url: string;
    /** One selector per line, most stable first. */
    selectors: string;
    value: string;
    key: string;
    y: string;
    text: string;
    seconds: string;
};

let draftId = 0;

function blankDraft(type: MacroStepType = "click"): Draft {
    return {
        id: `d${++draftId}`,
        type,
        intent: "",
        optional: false,
        timeoutMs: undefined,
        url: "",
        selectors: "",
        value: "",
        key: "",
        y: "",
        text: "",
        seconds: "",
    };
}

function toDraft(step: MacroStep): Draft {
    const draft = blankDraft(step.type);
    draft.intent = step.intent;
    draft.optional = step.optional === true;
    draft.timeoutMs = step.timeout_ms;
    if ("selectors" in step && step.selectors) {
        draft.selectors = step.selectors.join("\n");
    }
    switch (step.type) {
        case "navigate":
            draft.url = step.url;
            break;
        case "fill":
        case "select":
            draft.value = step.value;
            break;
        case "press":
            draft.key = step.key;
            break;
        case "scroll":
            draft.y = step.y === undefined ? "" : String(step.y);
            break;
        case "wait_for":
            draft.text = step.text ?? "";
            break;
        case "wait":
            draft.seconds = String(step.ms / 1000);
            break;
    }
    return draft;
}

/** The step as the inputs describe it; `checkSteps` decides if it is valid. */
function fromDraft(draft: Draft): Record<string, unknown> {
    const selectors = draft.selectors
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
    const base: Record<string, unknown> = {
        type: draft.type,
        intent: draft.intent,
        optional: draft.optional,
        timeout_ms: draft.timeoutMs,
    };
    switch (draft.type) {
        case "navigate":
            return { ...base, url: draft.url };
        case "click":
            return { ...base, selectors };
        case "fill":
        case "select":
            return { ...base, selectors, value: draft.value };
        case "press":
            return { ...base, key: draft.key, selectors };
        case "scroll":
            return {
                ...base,
                selectors,
                y: draft.y.trim() === "" ? undefined : Number(draft.y),
            };
        case "wait_for":
            return { ...base, selectors, text: draft.text };
        case "wait":
            return {
                ...base,
                ms:
                    draft.seconds.trim() === "" ?
                        undefined
                    :   Math.round(Number(draft.seconds) * 1000),
            };
    }
}

const NEEDS_SELECTORS: MacroStepType[] = ["click", "fill", "select"];
const TAKES_SELECTORS: MacroStepType[] = [
    ...NEEDS_SELECTORS,
    "press",
    "scroll",
    "wait_for",
];

type TestResult = TestMacroResponse["steps"][number];

const RESULT_MARK: Record<
    TestResult["status"],
    { icon: typeof CircleCheck; label: string; className: string }
> = {
    ok: {
        icon: CircleCheck,
        label: "Passed",
        className: "text-emerald-700 dark:text-emerald-400",
    },
    failed: {
        icon: CircleAlert,
        label: "Failed",
        className: "text-destructive",
    },
    skipped: {
        icon: CircleSlash,
        label: "Skipped",
        className: "text-muted-foreground",
    },
};

export function StepEditor({
    monitorId,
    initialSteps,
    savedSecrets,
    isSaving,
    onSave,
    onCancel,
}: {
    monitorId: string;
    initialSteps: MacroStep[];
    /** Names of the Monitor's saved secrets, offered for `fill` values. */
    savedSecrets: string[];
    isSaving: boolean;
    onSave: (steps: MacroStep[]) => void;
    onCancel: () => void;
}) {
    const [drafts, setDrafts] = React.useState<Draft[]>(() =>
        initialSteps.length ? initialSteps.map(toDraft) : [blankDraft("click")],
    );
    const [problem, setProblem] = React.useState<{
        message: string;
        step: number | null;
    } | null>(null);
    const [testing, setTesting] = React.useState(false);
    const [test, setTest] = React.useState<TestMacroResponse | null>(null);
    const [testError, setTestError] = React.useState<string | null>(null);

    // Any edit makes an earlier test result say nothing about these steps.
    const edit = (next: Draft[] | ((current: Draft[]) => Draft[])) => {
        setDrafts(next);
        setTest(null);
        setTestError(null);
        setProblem(null);
    };
    const patch = (id: string, fields: Partial<Draft>) =>
        edit(current =>
            current.map(d => (d.id === id ? { ...d, ...fields } : d)),
        );
    const move = (index: number, by: -1 | 1) =>
        edit(current => {
            const target = index + by;
            if (target < 0 || target >= current.length) return current;
            const next = [...current];
            [next[index], next[target]] = [next[target]!, next[index]!];
            return next;
        });

    /** The checked steps, or null after showing what is wrong. */
    function checked(): MacroStep[] | null {
        const result = checkSteps(drafts.map(fromDraft));
        if (!result.ok) {
            setProblem({ message: result.error, step: result.step });
            return null;
        }
        setProblem(null);
        return result.steps;
    }

    async function runTest() {
        const steps = checked();
        if (!steps) return;
        setTesting(true);
        setTest(null);
        setTestError(null);
        try {
            setTest(await testSteps(monitorId, steps));
        } catch (error) {
            setTestError(
                error instanceof Error ?
                    error.message
                :   "The test could not run. Try again.",
            );
        } finally {
            setTesting(false);
        }
    }

    const currentSteps = React.useMemo(() => {
        const result = checkSteps(drafts.map(fromDraft));
        return result.ok ? result.steps : [];
    }, [drafts]);
    const missingSecrets = secretNames(currentSteps).filter(
        name => !savedSecrets.includes(name),
    );

    return (
        <div className="space-y-4" data-testid="step-editor">
            <ol className="space-y-3">
                {drafts.map((draft, i) => {
                    const result = test?.steps[i];
                    const mark = result ? RESULT_MARK[result.status] : null;
                    const fieldId = (name: string) => `${draft.id}-${name}`;
                    return (
                        <li
                            key={draft.id}
                            data-testid="editor-step"
                            data-result={result?.status}
                            className={cn(
                                "min-w-0 space-y-3 rounded-lg border p-3",
                                problem?.step === i && "border-destructive",
                                result?.status === "failed" &&
                                    "border-destructive/60",
                            )}>
                            <div className="flex items-center gap-2">
                                <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums">
                                    {i + 1}
                                </span>
                                <Select
                                    value={draft.type}
                                    onValueChange={type =>
                                        patch(draft.id, {
                                            type: type as MacroStepType,
                                        })
                                    }>
                                    <SelectTrigger
                                        aria-label={`Type of step ${i + 1}`}
                                        className="min-w-0 flex-1 sm:max-w-56">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {MACRO_STEP_TYPES.map(type => (
                                            <SelectItem key={type} value={type}>
                                                {STEP_TYPE_LABEL[type]}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <div className="ml-auto flex shrink-0 gap-0.5">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Move step ${i + 1} up`}
                                        disabled={i === 0}
                                        onClick={() => move(i, -1)}>
                                        <ArrowUp />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Move step ${i + 1} down`}
                                        disabled={i === drafts.length - 1}
                                        onClick={() => move(i, 1)}>
                                        <ArrowDown />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Remove step ${i + 1}`}
                                        onClick={() =>
                                            edit(current =>
                                                current.filter(
                                                    d => d.id !== draft.id,
                                                ),
                                            )
                                        }>
                                        <Trash2 />
                                    </Button>
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <Label htmlFor={fieldId("intent")}>
                                    What this step is for
                                </Label>
                                <Input
                                    id={fieldId("intent")}
                                    placeholder="Open the Billing tab"
                                    value={draft.intent}
                                    onChange={e =>
                                        patch(draft.id, {
                                            intent: e.target.value,
                                        })
                                    }
                                />
                            </div>

                            {draft.type === "navigate" ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("url")}>
                                        Address
                                    </Label>
                                    <Input
                                        id={fieldId("url")}
                                        type="url"
                                        placeholder="https://example.com/account"
                                        value={draft.url}
                                        onChange={e =>
                                            patch(draft.id, {
                                                url: e.target.value,
                                            })
                                        }
                                    />
                                </div>
                            :   null}

                            {TAKES_SELECTORS.includes(draft.type) ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("selectors")}>
                                        Selectors
                                        {NEEDS_SELECTORS.includes(draft.type) ?
                                            ""
                                        :   " (optional)"}
                                    </Label>
                                    <Textarea
                                        id={fieldId("selectors")}
                                        className="min-h-16 font-mono text-xs"
                                        spellCheck={false}
                                        placeholder={
                                            'role=button[name="Sign in"]\ntext=Sign in\ncss=#sign-in'
                                        }
                                        value={draft.selectors}
                                        onChange={e =>
                                            patch(draft.id, {
                                                selectors: e.target.value,
                                            })
                                        }
                                    />
                                    <p className="text-muted-foreground text-xs">
                                        One per line, most stable first. The
                                        first that matches exactly one visible
                                        element is used.
                                    </p>
                                </div>
                            :   null}

                            {draft.type === "fill" || draft.type === "select" ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("value")}>
                                        {draft.type === "fill" ?
                                            "Text to type"
                                        :   "Option to choose"}
                                    </Label>
                                    <Input
                                        id={fieldId("value")}
                                        className="font-mono"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={draft.value}
                                        onChange={e =>
                                            patch(draft.id, {
                                                value: e.target.value,
                                            })
                                        }
                                    />
                                    {draft.type === "fill" ?
                                        <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
                                            {savedSecrets.length ?
                                                <>
                                                    <span>Type a secret:</span>
                                                    {savedSecrets.map(name => (
                                                        <button
                                                            key={name}
                                                            type="button"
                                                            onClick={() =>
                                                                patch(
                                                                    draft.id,
                                                                    {
                                                                        value: secretRef(
                                                                            name,
                                                                        ),
                                                                    },
                                                                )
                                                            }
                                                            className="hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 rounded-full border px-2 py-0.5 font-mono outline-none focus-visible:ring-[3px]">
                                                            {name}
                                                        </button>
                                                    ))}
                                                </>
                                            :   <span>
                                                    Never write a password here.
                                                    Save it as a secret below,
                                                    then refer to it as{" "}
                                                    <code className="bg-muted rounded px-1 font-mono">
                                                        {secretRef("name")}
                                                    </code>
                                                    .
                                                </span>
                                            }
                                        </div>
                                    :   null}
                                </div>
                            :   null}

                            {draft.type === "press" ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("key")}>Key</Label>
                                    <Input
                                        id={fieldId("key")}
                                        className="font-mono sm:max-w-56"
                                        placeholder="Enter"
                                        value={draft.key}
                                        onChange={e =>
                                            patch(draft.id, {
                                                key: e.target.value,
                                            })
                                        }
                                    />
                                </div>
                            :   null}

                            {draft.type === "scroll" ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("y")}>
                                        Or scroll the page by (pixels)
                                    </Label>
                                    <Input
                                        id={fieldId("y")}
                                        type="number"
                                        inputMode="numeric"
                                        className="sm:max-w-56"
                                        placeholder="800"
                                        value={draft.y}
                                        onChange={e =>
                                            patch(draft.id, {
                                                y: e.target.value,
                                            })
                                        }
                                    />
                                </div>
                            :   null}

                            {draft.type === "wait_for" ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("text")}>
                                        Or wait for this text to appear
                                    </Label>
                                    <Input
                                        id={fieldId("text")}
                                        placeholder="Welcome back"
                                        value={draft.text}
                                        onChange={e =>
                                            patch(draft.id, {
                                                text: e.target.value,
                                            })
                                        }
                                    />
                                </div>
                            :   null}

                            {draft.type === "wait" ?
                                <div className="space-y-1.5">
                                    <Label htmlFor={fieldId("seconds")}>
                                        Seconds to wait
                                    </Label>
                                    <Input
                                        id={fieldId("seconds")}
                                        type="number"
                                        inputMode="decimal"
                                        min={0}
                                        max={60}
                                        step={0.5}
                                        className="sm:max-w-56"
                                        placeholder="2"
                                        value={draft.seconds}
                                        onChange={e =>
                                            patch(draft.id, {
                                                seconds: e.target.value,
                                            })
                                        }
                                    />
                                </div>
                            :   null}

                            {(
                                draft.type !== "wait" &&
                                draft.type !== "navigate"
                            ) ?
                                <div className="flex items-start gap-2">
                                    <Checkbox
                                        id={fieldId("optional")}
                                        className="mt-0.5"
                                        checked={draft.optional}
                                        onCheckedChange={value =>
                                            patch(draft.id, {
                                                optional: value === true,
                                            })
                                        }
                                    />
                                    <Label
                                        htmlFor={fieldId("optional")}
                                        className="text-muted-foreground font-normal">
                                        Skip this step when its element is not
                                        there (a cookie banner, a sign-in form
                                        when already signed in)
                                    </Label>
                                </div>
                            :   null}

                            {result && mark ?
                                <div
                                    role="status"
                                    className={cn(
                                        "flex items-start gap-2 text-sm",
                                        mark.className,
                                    )}>
                                    <mark.icon className="mt-0.5 size-4 shrink-0" />
                                    <p className="min-w-0 break-words">
                                        <span className="font-medium">
                                            {mark.label}
                                        </span>
                                        {result.duration_ms > 0 ?
                                            ` in ${formatDuration(result.duration_ms)}`
                                        :   ""}
                                        {result.error ?
                                            `: ${result.error}`
                                        :   ""}
                                        {result.selector ?
                                            <span className="text-muted-foreground">
                                                {" "}
                                                · found with{" "}
                                                <code className="font-mono break-all">
                                                    {result.selector}
                                                </code>
                                            </span>
                                        :   null}
                                    </p>
                                </div>
                            :   null}
                        </li>
                    );
                })}
            </ol>

            <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={drafts.length >= MACRO_MAX_STEPS}
                onClick={() => edit(current => [...current, blankDraft()])}>
                <Plus />
                Add a step
            </Button>

            {missingSecrets.length ?
                <p className="text-sm text-amber-700 dark:text-amber-300">
                    These steps type{" "}
                    {missingSecrets.length === 1 ? "a secret" : "secrets"} that{" "}
                    {missingSecrets.length === 1 ? "is" : "are"} not saved yet:{" "}
                    <span className="font-mono">
                        {missingSecrets.join(", ")}
                    </span>
                    . Add {missingSecrets.length === 1 ? "it" : "them"} under
                    Secrets below, or the step will fail.
                </p>
            :   null}

            {problem ?
                <p role="alert" className="text-destructive text-sm">
                    {problem.message}
                </p>
            :   null}

            {testError ?
                <p role="alert" className="text-destructive text-sm">
                    {testError}
                </p>
            : test ?
                <div
                    role="status"
                    data-testid="test-result"
                    className={cn(
                        "space-y-2 rounded-lg border p-3 text-sm",
                        test.ok ?
                            "border-emerald-500/40 bg-emerald-500/10"
                        :   "border-destructive/40 bg-destructive/10",
                    )}>
                    <p className="font-medium">
                        {test.ok ?
                            "Every step worked."
                        :   `The replay stopped${
                                test.failed_step !== null ?
                                    ` at step ${test.failed_step + 1}`
                                :   ""
                            }${test.error ? `: ${test.error}` : "."}`
                        }
                    </p>
                    {test.screenshot_key ?
                        <figure className="space-y-1">
                            <figcaption className="text-muted-foreground text-xs">
                                Where the page ended up
                            </figcaption>
                            <div className="bg-background max-h-80 overflow-y-auto rounded-md border">
                                <ObjectImage
                                    objectKey={test.screenshot_key}
                                    alt="The page after the last step that ran"
                                />
                            </div>
                        </figure>
                    :   null}
                </div>
            :   null}

            <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                    type="button"
                    variant="outline"
                    data-testid="test-steps"
                    isLoading={testing}
                    disabled={isSaving}
                    onClick={() => void runTest()}>
                    {testing ? null : <FlaskConical />}
                    {testing ? "Replaying the steps…" : "Test these steps"}
                </Button>
                <Button
                    type="button"
                    data-testid="save-steps"
                    isLoading={isSaving}
                    disabled={testing}
                    onClick={() => {
                        const steps = checked();
                        if (steps) onSave(steps);
                    }}>
                    Save as a new version
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    disabled={isSaving}
                    onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
