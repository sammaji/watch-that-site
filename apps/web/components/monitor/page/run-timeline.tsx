"use client";

import {
    MACRO_STATUS_LABEL,
    RUN_KIND_LABEL,
    formatDateTime,
    formatTokens,
} from "@/components/monitor/format";
import { RunOutcomePill } from "@/components/monitor/pills";
import { planNote, runSummary } from "@/components/monitor/run-copy";
import type { TimelineRun } from "@/hooks/use-monitor-runs";
import type { WatchPlan } from "@watchthatsite/types";
import { cn } from "@watchthatsite/ui/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import React from "react";

/**
 * The Monitor's recent Runs, newest first. Every Run says what it concluded
 * in a few words, the quiet ones included, so the owner can see the Monitor
 * is working and why it stayed silent. A Run opens its Trace.
 */
export function RunTimeline({
    runs,
    plan,
    isLoading,
}: {
    runs: TimelineRun[];
    plan: WatchPlan | null;
    isLoading?: boolean;
}) {
    const counts = React.useMemo(() => {
        const c = { change: 0, quiet: 0, failed: 0 };
        for (const run of runs) {
            if (run.status === "failed") c.failed++;
            else if (run.verdict === "change") c.change++;
            else if (run.verdict === "noise" || run.verdict === "none") {
                c.quiet++;
            }
        }
        return c;
    }, [runs]);

    return (
        <section aria-label="Timeline" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-lg font-medium">Recent Runs</h2>
                {runs.length ?
                    <p className="text-muted-foreground text-xs">
                        {counts.change} with a Change · {counts.quiet} quiet ·{" "}
                        {counts.failed} failed
                    </p>
                :   null}
            </div>

            {isLoading ?
                <p className="text-muted-foreground py-8 text-center text-sm">
                    Loading Runs…
                </p>
            : runs.length === 0 ?
                <p className="text-muted-foreground rounded-md border border-dashed px-4 py-10 text-center text-sm">
                    No Runs yet. Press “Run now” to take the first Capture; it
                    becomes the Baseline later Runs are compared with.
                </p>
            :   <ol
                    data-testid="timeline"
                    className="divide-y overflow-hidden rounded-lg border">
                    {runs.map(run => (
                        <TimelineRow key={run.id} run={run} plan={plan} />
                    ))}
                </ol>
            }

            {runs.length ?
                <p className="text-muted-foreground text-xs">
                    Showing the latest {runs.length}.{" "}
                    <Link
                        href="/monitor-runs"
                        className="underline underline-offset-2">
                        All Runs
                    </Link>
                </p>
            :   null}
        </section>
    );
}

/**
 * One Run as a row: its outcome, what it concluded, and what it took. The
 * whole row opens the Run's Trace. `monitorName` is shown on lists that span
 * Monitors.
 */
export function TimelineRow({
    run,
    plan,
    monitorName,
}: {
    run: TimelineRun;
    plan?: WatchPlan | null;
    monitorName?: string;
}) {
    const created = new Date(run.created_at);
    const change = run.changes?.[0];
    const summary = runSummary(run);
    const tokens = formatTokens(run.input_tokens, run.output_tokens);
    const meta = [
        run.trigger === "schedule" ?
            ""
        :   (RUN_KIND_LABEL[run.trigger] ?? run.trigger),
        planNote(run, plan),
        tokens,
    ].filter(Boolean);
    const quiet =
        run.status === "succeeded" &&
        (run.verdict === "none" ||
            run.verdict === "noise" ||
            run.verdict === "baseline");

    return (
        <li
            data-testid="timeline-run"
            data-verdict={
                run.status === "failed" ? "failed" : (run.verdict ?? run.status)
            }
            className="hover:bg-muted/40 relative flex min-w-0 items-start gap-3 px-3 py-2.5 transition-colors">
            <div className="w-[8.5rem] shrink-0 pt-0.5 max-sm:hidden">
                <RunOutcomePill status={run.status} verdict={run.verdict} />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
                    <RunOutcomePill status={run.status} verdict={run.verdict} />
                </div>
                {monitorName ?
                    <p className="text-muted-foreground truncate text-xs">
                        {monitorName}
                    </p>
                :   null}
                <p
                    className={cn(
                        "line-clamp-2 text-sm break-words",
                        quiet && "text-muted-foreground",
                        run.status === "failed" && "text-destructive",
                        run.verdict === "change" && "font-medium",
                    )}>
                    {summary}
                </p>
                <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                    <time
                        dateTime={run.created_at}
                        title={formatDateTime(run.created_at)}>
                        {formatDistanceToNow(created, { addSuffix: true })}
                    </time>
                    {run.macro_status && run.macro_status !== "ok" ?
                        <span
                            className={cn(
                                "font-medium",
                                run.macro_status === "repaired" ?
                                    "text-amber-700 dark:text-amber-300"
                                :   "text-destructive",
                            )}>
                            · {MACRO_STATUS_LABEL[run.macro_status]}
                        </span>
                    :   null}
                    {meta.map(part => (
                        <span key={part}>· {part}</span>
                    ))}
                    {change ?
                        <Link
                            href={`/changes/${change.id}`}
                            className="text-foreground relative z-10 underline underline-offset-2">
                            Open the Change
                        </Link>
                    :   null}
                </p>
            </div>
            <ChevronRight className="text-muted-foreground mt-1 size-4 shrink-0" />
            {/* The whole row opens the Trace; the Change link sits above it. */}
            <Link
                href={`/monitor-runs/${run.id}`}
                aria-label={`Open the Trace of the Run from ${formatDateTime(run.created_at)}`}
                className="focus-visible:ring-ring/50 absolute inset-0 outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
            />
        </li>
    );
}
