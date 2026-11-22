"use client";
import { replaceQuery } from "@/lib/url";

import { MacroTab } from "@/components/macro/macro-tab";
import { runSummary } from "@/components/monitor/run-copy";
import { TAB_CLASS } from "@/components/monitor/tab-class";
import { useMacros } from "@/hooks/use-macros";
import { useMonitorTimeline, useRunNow } from "@/hooks/use-monitor-runs";
import {
    useMonitor,
    useMonitorState,
    type Monitor,
} from "@/hooks/use-monitors";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@watchthatsite/ui/components/tabs";
import { ArrowLeft, LoaderCircle, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChangesList } from "./changes-list";
import { InstructionsTab } from "./instructions-tab";
import { PauseControl } from "./pause-control";
import { RunTimeline } from "./run-timeline";
import { WatchPlanPanel } from "./watch-plan";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABS = ["timeline", "changes", "macro", "plan", "instructions"] as const;
type Tab = (typeof TABS)[number];

/**
 * The Monitor page: a header with status, Run now, pause and edit; the
 * Instructions, editable in place; then the timeline of Runs, the Changes,
 * the Macro, and how the page is watched. The open tab lives in `?tab=`.
 */
export function MonitorPage({ id }: { id: string }) {
    const valid = UUID.test(id);
    const { monitor, isLoading, error } = useMonitor(valid ? id : undefined);
    const { state } = useMonitorState(valid ? id : undefined);
    const timeline = useMonitorTimeline(valid ? id : undefined);
    const macros = useMacros(valid ? id : undefined);
    const pathname = usePathname();
    const searchParams = useSearchParams();

    if (valid && isLoading) {
        return (
            <div className="text-muted-foreground flex h-64 items-center justify-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin" />
                Loading the Monitor…
            </div>
        );
    }
    if (!valid || error || !monitor) {
        return (
            <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-3 text-sm">
                {error?.message ?? "Monitor not found."}
                <Link href="/monitors" className="underline underline-offset-2">
                    All Monitors
                </Link>
            </div>
        );
    }

    const requested = searchParams.get("tab") as Tab | null;
    const tab: Tab =
        requested && TABS.includes(requested) ? requested : "timeline";
    const setTab = (next: string) =>
        replaceQuery(pathname, params => {
            if (next === "timeline") params.delete("tab");
            else params.set("tab", next);
            params.delete("goal");
        });

    const macroNeedsYou =
        macros.pending?.status === "draft" ||
        macros.pending?.status === "failed";

    return (
        <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 p-4 py-6 sm:p-6">
            <MonitorHeader monitor={monitor} />

            <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
                <TabsList className="h-auto! min-h-9 w-full max-w-full flex-wrap justify-start sm:w-fit">
                    <TabsTrigger
                        value="timeline"
                        data-testid="tab-timeline"
                        className={TAB_CLASS}>
                        Timeline
                    </TabsTrigger>
                    <TabsTrigger
                        value="changes"
                        data-testid="tab-changes"
                        className={TAB_CLASS}>
                        Changes
                    </TabsTrigger>
                    <TabsTrigger
                        value="macro"
                        data-testid="tab-macro"
                        className={TAB_CLASS}>
                        Pre-scraping
                        {macroNeedsYou ?
                            <span
                                aria-label="needs your attention"
                                className="size-1.5 rounded-full bg-amber-500"
                            />
                        : macros.pending?.status === "recording" ?
                            <LoaderCircle className="size-3 animate-spin" />
                        :   null}
                    </TabsTrigger>
                    <TabsTrigger
                        value="plan"
                        data-testid="tab-plan"
                        className={TAB_CLASS}>
                        Monitored elements
                    </TabsTrigger>
                    <TabsTrigger
                        value="instructions"
                        data-testid="tab-instructions"
                        className={TAB_CLASS}>
                        Instructions
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="timeline">
                    <RunTimeline
                        runs={timeline.runs}
                        plan={monitor.watch_plan}
                        isLoading={timeline.isLoading}
                    />
                </TabsContent>
                <TabsContent value="changes">
                    <ChangesList monitorId={monitor.id} />
                </TabsContent>
                <TabsContent value="macro">
                    <MacroTab
                        monitor={monitor}
                        initialGoal={searchParams.get("goal") ?? ""}
                    />
                </TabsContent>
                <TabsContent value="plan">
                    <WatchPlanPanel monitor={monitor} state={state} />
                </TabsContent>
                <TabsContent value="instructions">
                    <InstructionsTab monitor={monitor} />
                </TabsContent>
            </Tabs>
        </main>
    );
}

function MonitorHeader({ monitor }: { monitor: Monitor }) {
    const runNow = useRunNow(monitor.id);
    const result = runNow.phase === "done" ? runNow.run : null;

    return (
        <header className="space-y-4">
            <Link
                href="/monitors"
                className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm">
                <ArrowLeft className="size-4" />
                Monitors
            </Link>

            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-2">
                    <h1 className="text-2xl font-semibold tracking-tight break-words">
                        {monitor.name}
                    </h1>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                        data-testid="run-now"
                        isLoading={runNow.isRunning}
                        onClick={() => void runNow.start("manual")}>
                        {runNow.isRunning ? null : <Play className="size-4" />}
                        {runNow.isRunning ? "Running…" : "Run now"}
                    </Button>
                    <PauseControl monitor={monitor} />
                    <Button asChild variant="outline">
                        <Link href={`/monitors/edit/${monitor.id}`}>
                            <Pencil className="size-4" />
                            Edit
                        </Link>
                    </Button>
                </div>
            </div>

            {runNow.isRunning || result || runNow.error ?
                <div
                    role="status"
                    aria-live="polite"
                    className="bg-muted/40 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm">
                    {runNow.isRunning ?
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            {runNow.phase === "starting" ?
                                "Starting a Run…"
                            :   "Capturing the page and comparing it with the last Capture…"
                            }
                        </>
                    : runNow.error ?
                        <span className="text-destructive">
                            The Run did not finish: {runNow.error}
                        </span>
                    : result ?
                        <>
                            <span
                                className={
                                    result.status === "failed" ?
                                        "text-destructive break-words"
                                    :   "break-words"
                                }>
                                {result.status === "failed" ?
                                    "The Run failed: "
                                :   "The Run finished: "}
                                <strong className="font-medium">
                                    {runSummary({
                                        status: result.status,
                                        summary: result.summary ?? null,
                                        error: result.error,
                                        invalid_reason: result.invalid_reason,
                                        verdict: result.verdict,
                                    })}
                                </strong>
                            </span>
                            {result.change_id ?
                                <Link
                                    href={`/changes/${result.change_id}`}
                                    className="underline underline-offset-2">
                                    Open the Change
                                </Link>
                            :   <Link
                                    href={`/monitor-runs/${result.run_id}`}
                                    className="underline underline-offset-2">
                                    How it was checked
                                </Link>
                            }
                        </>
                    :   null}
                </div>
            :   null}
        </header>
    );
}
