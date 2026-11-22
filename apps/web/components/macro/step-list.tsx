"use client";

import { StepShot } from "@/components/monitor/step-shot";
import {
    describeStep,
    type MacroStep,
    type RunStepStatus,
} from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import { cn } from "@watchthatsite/ui/lib/utils";
import { STEP_TYPE_LABEL, stepSpecifics } from "./step-format";

export type StepOutcome = {
    status: RunStepStatus;
    screenshotKey: string | null;
};

const OUTCOME_BADGE: Partial<
    Record<RunStepStatus, { label: string; className: string }>
> = {
    repaired: {
        label: "Repaired on the last Run",
        className:
            "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    },
    skipped: { label: "Skipped on the last Run", className: "" },
    failed: {
        label: "Failed on the last Run",
        className: "border-destructive/40 text-destructive",
    },
};

/**
 * Pre-scraping's steps as a vertical stepper: each step's intent, then what
 * it does and to what ("Type ‹secret email› → …", "Click …"), and (when
 * given) how it went and what the page looked like on the last replay.
 */
export function StepList({
    steps,
    outcomes,
}: {
    steps: MacroStep[];
    /** One entry per step, in order; missing entries show nothing. */
    outcomes?: (StepOutcome | undefined)[];
}) {
    if (steps.length === 0) {
        return (
            <p className="text-muted-foreground text-sm">
                This version has no steps.
            </p>
        );
    }
    return (
        <ol data-testid="macro-steps">
            {steps.map((step, i) => {
                const outcome = outcomes?.[i];
                const badge = outcome ? OUTCOME_BADGE[outcome.status] : null;
                const title = describeStep(step);
                const specifics = stepSpecifics(step);
                const last = i === steps.length - 1;
                return (
                    <li
                        key={i}
                        data-testid="macro-step"
                        className="flex min-w-0 items-start gap-3">
                        <div className="flex shrink-0 flex-col items-center self-stretch">
                            <span className="bg-muted text-foreground flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular-nums">
                                {i + 1}
                            </span>
                            {last ? null : (
                                <span className="bg-border my-1 w-px flex-1" />
                            )}
                        </div>
                        <div
                            className={cn(
                                "min-w-0 flex-1 space-y-0.5 pt-0.5",
                                !last && "pb-5",
                            )}>
                            <p className="text-sm break-words">{title}</p>
                            <p className="text-muted-foreground text-xs break-all">
                                {STEP_TYPE_LABEL[step.type]}
                                {specifics ?
                                    <>
                                        {" "}
                                        <span className="font-mono">
                                            {specifics}
                                        </span>
                                    </>
                                :   null}
                            </p>
                            {badge ?
                                <Badge
                                    variant="outline"
                                    className={cn("mt-1", badge.className)}>
                                    {badge.label}
                                </Badge>
                            :   null}
                        </div>
                        {outcome?.screenshotKey ?
                            <StepShot
                                screenshotKey={outcome.screenshotKey}
                                caption={`Step ${i + 1}: ${title}`}
                                className="w-16 sm:w-20"
                            />
                        :   null}
                    </li>
                );
            })}
        </ol>
    );
}
