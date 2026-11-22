"use client";

import { replanAction } from "@/app/actions/scheduler";
import { sectionRects } from "@/components/change/lib";
import {
    BoxOverlay,
    ObjectImage,
    type Box,
} from "@/components/change/object-image";
import { TraceStep } from "@/components/monitor/run-trace";
import { Segmented } from "@/components/monitor/segmented";
import { useStoredBlocks } from "@/hooks/use-change";
import { useConnections } from "@/hooks/use-connections";
import { useCapture } from "@/hooks/use-monitor-runs";
import {
    useInvalidateMonitors,
    usePatchMonitor,
    type Monitor,
    type MonitorState,
} from "@/hooks/use-monitors";
import { usePlanningSteps } from "@/hooks/use-run-steps";
import type { WatchHow, WatchPlan } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import { cn } from "@watchthatsite/ui/lib/utils";
import { LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import React from "react";
import { toast } from "sonner";

/**
 * "Monitored elements": the Watch Plan the agent made from the
 * Instructions. Each Section of the page is watched for its words, its looks,
 * both, or not at all; the owner can change any of them, or ask for a new
 * plan. The Baseline screenshot next to the list shows where each Section is.
 */

export const HOW_OPTIONS: ReadonlyArray<{ value: WatchHow; label: string }> = [
    { value: "text", label: "Text" },
    { value: "visual", label: "Looks" },
    { value: "both", label: "Both" },
    { value: "ignore", label: "Ignore" },
];

export const HOW_LABEL: Record<WatchHow, string> = {
    text: "Text",
    visual: "Looks",
    both: "Text and looks",
    ignore: "Ignored",
};

/** What a new choice means, said plainly. `name` is a Section's name. */
export function howConsequence(name: string, how: WatchHow): string {
    switch (how) {
        case "ignore":
            return `Changes in ${name} will no longer be reported.`;
        case "text":
            return `From now on only the words in ${name} are compared.`;
        case "visual":
            return `From now on only how ${name} looks is compared.`;
        case "both":
            return `From now on both the words and the look of ${name} are compared.`;
    }
}

const REST_ID = "__rest__";

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
            {children}
        </p>
    );
}

export function WatchPlanPanel({
    monitor,
    state,
}: {
    monitor: Monitor;
    state: MonitorState | null;
}) {
    const plan = monitor.watch_plan;
    const baselineRunId = state?.previous_run_id ?? null;
    const connections = useConnections();
    const patch = usePatchMonitor();
    const invalidateMonitors = useInvalidateMonitors();
    const { capture } = useCapture(baselineRunId);
    const { blocks } = useStoredBlocks(plan ? capture?.blocks_key : null);
    const [hovered, setHovered] = React.useState<string | null>(null);
    const [replanning, setReplanning] = React.useState<string | null>(null);
    const [replanError, setReplanError] = React.useState<string | null>(null);
    const planningSteps = usePlanningSteps(monitor.id, replanning);
    const [loadedSize, setSize] = React.useState<[number, number] | null>(null);
    // The Capture records its screenshot's size, so the outlines can be
    // placed before the image has loaded.
    const metaShot = capture?.meta?.screenshot as
        { w?: number; h?: number } | undefined;
    const metaW = metaShot?.w;
    const metaH = metaShot?.h;
    const size = React.useMemo<[number, number] | null>(
        () => loadedSize ?? (metaW && metaH ? [metaW, metaH] : null),
        [loadedSize, metaW, metaH],
    );
    const stageRef = React.useRef<HTMLDivElement>(null);

    const rects = React.useMemo(
        () => sectionRects(plan, blocks?.blocks),
        [plan, blocks],
    );

    // Bring the hovered Section into view on the screenshot.
    React.useEffect(() => {
        const stage = stageRef.current;
        const rect = hovered ? rects.get(hovered) : null;
        if (!stage || !rect || !size) return;
        const scale = stage.clientWidth / size[0];
        stage.scrollTo({
            top: Math.max(0, rect[1] * scale - stage.clientHeight / 4),
            behavior: "smooth",
        });
    }, [hovered, rects, size]);

    // When the connections cannot be listed, trust the Monitor's own column.
    const hasConnection =
        !!monitor.connection_id &&
        (connections.data ?
            connections.data.some(c => c.id === monitor.connection_id)
        :   true);

    async function setHow(sectionId: string, how: WatchHow) {
        if (!plan) return;
        const name =
            sectionId === REST_ID ?
                "the rest of the page"
            :   (plan.sections.find(s => s.id === sectionId)?.name ??
                "this section");
        const next: WatchPlan = {
            ...plan,
            // "" says a person changed the plan last, so the next plan the
            // agent makes keeps these choices where the Section still exists.
            model: "",
            rest: sectionId === REST_ID ? how : plan.rest,
            sections: plan.sections.map(section =>
                section.id === sectionId ? { ...section, how } : section,
            ),
        };
        try {
            await patch.mutateAsync({
                id: monitor.id,
                patch: { watch_plan: next },
            });
            toast.success(howConsequence(name, how));
        } catch (err) {
            toast.error(
                err instanceof Error ?
                    `The change was not saved: ${err.message}`
                :   "The change was not saved. Try again.",
            );
        }
    }

    async function replan() {
        setReplanError(null);
        // A few seconds back, so steps stamped by a server whose clock runs
        // slightly behind this browser's still show up.
        setReplanning(new Date(Date.now() - 5_000).toISOString());
        const result = await replanAction(monitor.id);
        setReplanning(null);
        if (!result.ok) {
            setReplanError(result.error);
            return;
        }
        invalidateMonitors();
        const n = result.data.sections.length;
        toast.success(
            `The page was planned: ${n} section${n === 1 ? "" : "s"}.`,
        );
    }

    const planButton = (
        <Button
            variant="outline"
            size="sm"
            data-testid="plan-again"
            disabled={replanning !== null}
            onClick={() => void replan()}>
            {replanning !== null ?
                <LoaderCircle className="animate-spin" />
            :   <RefreshCw />}
            Plan the page
        </Button>
    );

    const progress =
        replanning !== null || replanError ?
            <div
                role="status"
                aria-live="polite"
                className="bg-muted/40 space-y-1 rounded-md border px-3 py-2 text-sm">
                {replanError ?
                    <p className="text-destructive">
                        The page could not be planned: {replanError}
                    </p>
                :   <p className="flex items-center gap-2">
                        <LoaderCircle className="size-4 animate-spin" />
                        The agent is reading the page and your Instructions…
                    </p>
                }
                {planningSteps.length ?
                    <ol className="divide-y">
                        {planningSteps.map(step => (
                            <TraceStep key={step.id} step={step} />
                        ))}
                    </ol>
                :   null}
            </div>
        :   null;

    const heading = (
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">Monitored elements</h2>
            {/* Only a Monitor with no plan yet is offered one; a plan is
                redone on its own when the Instructions or the page change. */}
            {baselineRunId && !plan && hasConnection ? planButton : null}
        </div>
    );

    if (!plan) {
        return (
            <section aria-label="Monitored elements" className="space-y-3">
                {heading}
                {progress}
                {!baselineRunId ?
                    <Notice>
                        The page will be planned on its first check.
                    </Notice>
                : !hasConnection && !connections.isLoading ?
                    <Notice>
                        The whole page is being watched, as text and as looks.
                        With a model connection the agent divides the page into
                        sections and watches each the way your Instructions
                        need.{" "}
                        <Link
                            href="/settings/connections"
                            className="text-foreground underline underline-offset-2">
                            Add a connection
                        </Link>
                        , then choose it for this Monitor under{" "}
                        <Link
                            href={`/monitors/edit/${monitor.id}`}
                            className="text-foreground underline underline-offset-2">
                            Edit → More options
                        </Link>
                        .
                    </Notice>
                :   <Notice>
                        This page has not been planned yet, so the whole page is
                        watched, as text and as looks. It is planned on the next
                        Run, or right now with “Plan the page”.
                    </Notice>
                }
            </section>
        );
    }

    const boxes: Box[] = plan.sections
        .filter(section => rects.has(section.id))
        .map(section => ({
            key: section.id,
            rect: rects.get(section.id)!,
            label: section.name,
            tone:
                hovered === section.id ? "active"
                : section.how === "ignore" ? "ignored"
                : "section",
        }));

    return (
        <section aria-label="Monitored elements" className="space-y-3">
            {heading}
            {progress}

            {plan.wait_ms ?
                <p className="text-sm" data-testid="plan-wait">
                    The page keeps loading after it looks ready, so each check
                    waits {Math.round(plan.wait_ms / 100) / 10} s more before
                    the Capture.
                </p>
            :   null}

            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
                <ul className="min-w-0 space-y-2">
                    {plan.sections.map(section => (
                        <li
                            key={section.id}
                            data-testid="plan-section"
                            data-how={section.how}
                            onMouseEnter={() => setHovered(section.id)}
                            onMouseLeave={() => setHovered(null)}
                            onFocus={() => setHovered(section.id)}
                            onBlur={() => setHovered(null)}
                            className={cn(
                                "bg-card flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-3 transition-colors sm:flex-row sm:items-start sm:justify-between",
                                hovered === section.id && "bg-muted/50",
                            )}>
                            <div className="min-w-0 space-y-0.5">
                                <p
                                    className={cn(
                                        "text-sm font-medium break-words",
                                        section.how === "ignore" &&
                                            "text-muted-foreground",
                                    )}>
                                    {section.name}
                                    {rects.size > 0 && !rects.has(section.id) ?
                                        <span className="text-muted-foreground font-normal">
                                            {" "}
                                            · not on the page right now
                                        </span>
                                    :   null}
                                </p>
                                <p className="text-muted-foreground text-xs break-words">
                                    {section.why}
                                </p>
                            </div>
                            <Segmented
                                size="sm"
                                className="shrink-0"
                                label={`How ${section.name} is watched`}
                                value={section.how}
                                disabled={patch.isPending}
                                onChange={how => void setHow(section.id, how)}
                                options={HOW_OPTIONS}
                            />
                        </li>
                    ))}
                    <li
                        data-testid="plan-rest"
                        className="bg-muted/30 flex min-w-0 flex-col gap-2 rounded-lg border border-dashed px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-medium">
                                The rest of the page
                            </p>
                            <p className="text-muted-foreground text-xs">
                                Everything outside the sections above, including
                                content that appears later.
                            </p>
                        </div>
                        <Segmented
                            size="sm"
                            className="shrink-0"
                            label="How the rest of the page is watched"
                            value={plan.rest}
                            disabled={patch.isPending}
                            onChange={how => void setHow(REST_ID, how)}
                            options={HOW_OPTIONS}
                        />
                    </li>
                </ul>

                {capture?.screenshot_key ?
                    <figure
                        aria-label="The Baseline, with each section outlined"
                        className="min-w-0 lg:sticky lg:top-2 lg:self-start">
                        <div
                            ref={stageRef}
                            className="bg-muted/30 max-h-[70vh] overflow-x-hidden overflow-y-auto rounded-md border">
                            <div className="relative">
                                <ObjectImage
                                    shared
                                    objectKey={capture.screenshot_key}
                                    alt="The Baseline screenshot"
                                    onSize={setSize}
                                />
                                <BoxOverlay boxes={boxes} size={size} />
                            </div>
                        </div>
                    </figure>
                :   null}
            </div>
        </section>
    );
}
