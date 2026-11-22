"use client";

import type { AgentVerdict, RunStep } from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@watchthatsite/ui/components/collapsible";
import { cn } from "@watchthatsite/ui/lib/utils";
import {
    ChevronDown,
    CircleAlert,
    CircleCheck,
    CircleSlash,
    Eye,
    LayoutPanelTop,
    Wrench,
} from "lucide-react";
import type React from "react";
import { formatCount, formatDuration, formatTokens } from "./format";
import { StepShot } from "./step-shot";

/**
 * The Trace of a Run ("How it was checked"): the Macro steps replayed, then
 * the page being planned when the Run made a Watch Plan, then what the agent
 * looked at while comparing, then the model, turns and tokens.
 */

const STATUS_MARK: Record<
    RunStep["status"],
    { icon: typeof CircleCheck; className: string; label: string }
> = {
    ok: {
        icon: CircleCheck,
        className: "text-emerald-600 dark:text-emerald-400",
        label: "Done",
    },
    failed: {
        icon: CircleAlert,
        className: "text-destructive",
        label: "Failed",
    },
    repaired: {
        icon: Wrench,
        className: "text-amber-600 dark:text-amber-400",
        label: "Repaired",
    },
    skipped: {
        icon: CircleSlash,
        className: "text-muted-foreground",
        label: "Skipped",
    },
};

/** Detail keys shown as running text rather than as "key: value". */
const PROSE_KEYS = [
    "message",
    "text",
    "note",
    "said",
    "reason",
    "summary",
    "thought",
    "answer",
];

/** Bookkeeping a person has no use for (a step's position is already its number). */
const HIDDEN_KEYS = ["step", "index", "seq"];

function asText(value: unknown): string | null {
    if (typeof value === "string") return value.trim() || null;
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return null;
}

/** What a step recorded about itself, without assuming more than the common keys. */
function withoutSelector(detail: RunStep["detail"]): RunStep["detail"] {
    const rest = { ...(detail ?? {}) };
    delete rest.selector;
    return rest;
}

function StepDetail({ detail }: { detail: RunStep["detail"] }) {
    const entries = Object.entries(detail ?? {});
    if (entries.length === 0) return null;
    const error = asText(detail.error);
    const selector = asText(detail.selector);
    const prose = PROSE_KEYS.map(key => asText(detail[key])).filter(
        (value): value is string => !!value,
    );
    const rest = entries
        .filter(
            ([key]) =>
                key !== "error" &&
                key !== "selector" &&
                !PROSE_KEYS.includes(key) &&
                !HIDDEN_KEYS.includes(key),
        )
        .map(([key, value]) => [key, asText(value)] as const)
        .filter(
            (entry): entry is readonly [string, string] =>
                !!entry[1] && entry[1].length <= 160,
        );
    if (!error && !selector && prose.length === 0 && rest.length === 0) {
        return null;
    }
    return (
        <div className="mt-1 space-y-1 text-xs">
            {error ?
                <p className="text-destructive break-words">{error}</p>
            :   null}
            {prose.map((line, i) => (
                <p
                    key={i}
                    className="text-muted-foreground break-words whitespace-pre-wrap">
                    {line}
                </p>
            ))}
            {selector ?
                <p className="text-muted-foreground break-all">
                    Found with{" "}
                    <code className="bg-muted rounded px-1 py-0.5 font-mono">
                        {selector}
                    </code>
                </p>
            :   null}
            {rest.length ?
                <p className="text-muted-foreground font-mono break-all">
                    {rest
                        .map(
                            ([key, value]) =>
                                `${key.replace(/_/g, " ")}: ${value}`,
                        )
                        .join(" · ")}
                </p>
            :   null}
        </div>
    );
}

export function TraceStep({
    step,
    number,
    nested = false,
    stepper,
}: {
    step: RunStep;
    /** Shown in front of the title; omit for steps that are not numbered. */
    number?: number;
    nested?: boolean;
    /** Drawn as one step of a vertical stepper; `last` ends the line. */
    stepper?: { last: boolean };
}) {
    const mark = STATUS_MARK[step.status] ?? STATUS_MARK.ok;
    const Icon = mark.icon;
    const tokens = formatTokens(step.input_tokens, step.output_tokens);
    const loud = step.status === "repaired" || step.status === "skipped";
    // A step that went to plan reads as one line: what was found, what was
    // done to it, and how long it took.
    const found =
        stepper && step.status === "ok" ? asText(step.detail?.selector) : null;
    return (
        <li
            data-testid="trace-step"
            data-phase={step.phase}
            data-status={step.status}
            className={cn(
                "flex min-w-0 items-start gap-3",
                stepper ? "" : "py-2.5",
                !stepper &&
                    nested &&
                    "ml-3 border-l-2 border-amber-500/50 pl-3",
            )}>
            {stepper ?
                <StepperNode
                    status={step.status}
                    number={number}
                    label={mark.label}
                    last={stepper.last}
                />
            :   <Icon
                    aria-label={mark.label}
                    className={cn("mt-0.5 size-4 shrink-0", mark.className)}
                />
            }
            <div className={cn("min-w-0 flex-1", stepper && "pt-0.5 pb-5")}>
                <p className="text-sm break-words">
                    {number !== undefined && !stepper ?
                        <span className="text-muted-foreground tabular-nums">
                            {number}.{" "}
                        </span>
                    :   null}
                    {step.title || step.kind}
                </p>
                {found ?
                    <p className="text-muted-foreground mt-0.5 text-xs break-all">
                        Found element{" "}
                        <code className="bg-muted rounded px-1 py-0.5 font-mono">
                            {found}
                        </code>{" "}
                        → {step.kind.replace(/_/g, " ")}
                        {step.duration_ms > 0 ?
                            ` (${formatDuration(step.duration_ms)})`
                        :   ""}
                        {tokens ? ` · ${tokens}` : ""}
                    </p>
                :   <>
                        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                            {loud ?
                                <Badge
                                    variant="outline"
                                    className={cn(
                                        step.status === "repaired" &&
                                            "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300",
                                    )}>
                                    {step.status === "repaired" ?
                                        "Repaired by the agent"
                                    :   "Skipped"}
                                </Badge>
                            : step.status === "failed" ?
                                <Badge variant="destructive">Failed</Badge>
                            :   null}
                            <span>{step.kind.replace(/_/g, " ")}</span>
                            {step.duration_ms > 0 ?
                                <span>{formatDuration(step.duration_ms)}</span>
                            :   null}
                            {tokens ?
                                <span>{tokens}</span>
                            :   null}
                        </div>
                    </>
                }
                <StepDetail
                    detail={found ? withoutSelector(step.detail) : step.detail}
                />
            </div>
            {step.screenshot_key ?
                <StepShot
                    screenshotKey={step.screenshot_key}
                    caption={step.title || step.kind}
                    className={stepper ? "w-16 sm:w-20" : undefined}
                />
            :   null}
        </li>
    );
}

/**
 * The marker of one stepper step: a circle with the step's number, coloured
 * by how it went, and the line down to the next step. A repair has no number;
 * a failed or skipped step shows its icon instead.
 */
function StepperNode({
    status,
    number,
    label,
    last,
}: {
    status: RunStep["status"];
    number?: number;
    label: string;
    last: boolean;
}) {
    const tone =
        status === "failed" ?
            "border-destructive bg-destructive/10 text-destructive"
        : status === "repaired" ?
            "border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : status === "skipped" ?
            "border-dashed border-muted-foreground/50 text-muted-foreground"
        :   "border-border bg-muted text-foreground";
    return (
        <div className="flex shrink-0 flex-col items-center self-stretch">
            <span
                aria-label={label}
                className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                    tone,
                )}>
                {status === "failed" ?
                    <CircleAlert className="size-3.5" />
                : status === "repaired" ?
                    <Wrench className="size-3" />
                : status === "skipped" ?
                    <CircleSlash className="size-3" />
                : number !== undefined ?
                    number
                :   <CircleCheck className="size-3.5" />}
            </span>
            {last ? null : <span className="bg-border my-1 w-px flex-1" />}
        </div>
    );
}

/** A section of the Trace that folds away: "Before scraping". */
function FoldingPhase({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <Collapsible defaultOpen className="group min-w-0 rounded-lg border">
            <CollapsibleTrigger className="hover:bg-muted/40 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left">
                <h3 className="text-sm font-medium">{title}</h3>
                <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
                <ol className="border-t px-3 pt-3">{children}</ol>
            </CollapsibleContent>
        </Collapsible>
    );
}

function Phase({
    icon: Icon,
    title,
    hint,
    children,
}: {
    icon: typeof Eye;
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="min-w-0 rounded-lg border">
            <header className="bg-muted/40 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-2">
                <Icon className="text-muted-foreground size-4 shrink-0" />
                <h3 className="text-sm font-medium">{title}</h3>
                {hint ?
                    <p className="text-muted-foreground text-xs">{hint}</p>
                :   null}
            </header>
            <ol className="divide-y px-3">{children}</ol>
        </section>
    );
}

export function RunTrace({
    steps,
    agent,
    tokens,
    isLoading,
    emptyText = "Nothing was recorded for this Run.",
}: {
    steps: RunStep[];
    /** The comparison's own numbers, when the Run recorded a Change. */
    agent?: Partial<AgentVerdict> | null;
    /** Model usage across the whole Run. */
    tokens?: { input: number; output: number } | null;
    isLoading?: boolean;
    emptyText?: string;
}) {
    const macro = steps.filter(
        s => s.phase === "macro" || s.phase === "repair",
    );
    const plan = steps.filter(s => s.phase === "plan");
    const compare = steps.filter(s => s.phase === "compare");
    const total = formatTokens(tokens?.input, tokens?.output);

    // Repairs sit between the Macro steps they fixed and are not numbered.
    const macroNumbers = new Map<string, number>();
    for (const step of macro) {
        if (step.phase === "macro") {
            macroNumbers.set(step.id, macroNumbers.size + 1);
        }
    }

    return (
        <div className="space-y-4" data-testid="run-trace">
            {isLoading ?
                <p className="text-muted-foreground text-sm">
                    Loading the Trace…
                </p>
            : steps.length === 0 ?
                <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                    {emptyText}
                </p>
            :   null}

            {macro.length ?
                <FoldingPhase title="Before scraping">
                    {macro.map((step, i) => (
                        <TraceStep
                            key={step.id}
                            step={step}
                            nested={step.phase === "repair"}
                            number={macroNumbers.get(step.id)}
                            stepper={{ last: i === macro.length - 1 }}
                        />
                    ))}
                </FoldingPhase>
            :   null}

            {plan.length ?
                <Phase
                    icon={LayoutPanelTop}
                    title="Planning the page"
                    hint="The agent divided the page into sections">
                    {plan.map(step => (
                        <TraceStep key={step.id} step={step} />
                    ))}
                </Phase>
            :   null}

            {compare.length ?
                <Phase
                    icon={Eye}
                    title="What the agent looked at"
                    hint="While comparing the two Captures">
                    {compare.map(step => (
                        <TraceStep key={step.id} step={step} />
                    ))}
                </Phase>
            :   null}

            {agent?.model || total ?
                <dl className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
                    {agent?.model ?
                        <div className="flex gap-1.5">
                            <dt>Model</dt>
                            <dd className="text-foreground font-mono break-all">
                                {agent.model}
                            </dd>
                        </div>
                    :   null}
                    {agent?.steps ?
                        <div className="flex gap-1.5">
                            <dt>Turns</dt>
                            <dd className="text-foreground tabular-nums">
                                {agent.steps}
                            </dd>
                        </div>
                    :   null}
                    {total ?
                        <div className="flex gap-1.5">
                            <dt>Tokens</dt>
                            <dd className="text-foreground tabular-nums">
                                {formatCount(tokens?.input ?? 0)} in ·{" "}
                                {formatCount(tokens?.output ?? 0)} out
                            </dd>
                        </div>
                    :   null}
                </dl>
            :   null}
        </div>
    );
}
