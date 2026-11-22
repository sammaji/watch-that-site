"use client";
import { replaceQuery } from "@/lib/url";

import { acceptBaselineAction } from "@/app/actions/scheduler";
import { suppressionCopy } from "@/components/monitor/format";
import { MacroStatusPill } from "@/components/monitor/pills";
import { planNote } from "@/components/monitor/run-copy";
import { RunTrace } from "@/components/monitor/run-trace";
import { TAB_CLASS } from "@/components/monitor/tab-class";
import {
    ChangeDataProvider,
    useChangeMonitor,
    useChangeMutations,
    useChangeNeighbours,
    useChangeRecord,
    useChangeRow,
    useMarkViewed,
} from "@/hooks/use-change";
import { useRun } from "@/hooks/use-monitor-runs";
import { useRunSteps } from "@/hooks/use-run-steps";
import { countedOps, type ChangeRecord } from "@watchthatsite/types";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@watchthatsite/ui/components/alert-dialog";
import { Button } from "@watchthatsite/ui/components/button";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@watchthatsite/ui/components/tabs";
import { format } from "date-fns";
import {
    BellOff,
    ChevronLeft,
    ChevronRight,
    GitCompareArrows,
    LoaderCircle,
    ThumbsUp,
    X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { CompareDialog } from "./compare-dialog";
import { FullTextTab } from "./full-text-tab";
import { IgnoreEditor } from "./ignore-editor";
import { ItemsTab, type Locate } from "./items-tab";
import { SideBySideTab, type Focus } from "./side-by-side-tab";

/**
 * The Change view: one URL per Change, linked from every notification. It
 * opens on the agent's answer (the summary sentence and the Items) and keeps
 * the proof underneath: the screenshots side by side, the full text diff, and
 * how the Run was checked.
 */

type Tab = "what" | "side" | "text" | "trace";

function when(iso: string) {
    return format(new Date(iso), "PP p");
}

function PageSkeleton() {
    return (
        <div
            className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6"
            aria-busy="true">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-80 w-full" />
        </div>
    );
}

function Message({
    title,
    children,
}: {
    title: string;
    children?: React.ReactNode;
}) {
    return (
        <div className="mx-auto w-full max-w-2xl space-y-3 p-6 text-center">
            <h1 className="text-lg font-medium">{title}</h1>
            <div className="text-muted-foreground text-sm">{children}</div>
            <Button asChild variant="outline" size="sm">
                <Link href="/monitors">Back to Monitors</Link>
            </Button>
        </div>
    );
}

function NeighbourLink({
    id,
    direction,
}: {
    id: string | null;
    direction: "prev" | "next";
}) {
    const label = direction === "prev" ? "Previous Change" : "Next Change";
    const content =
        direction === "prev" ?
            <>
                <ChevronLeft /> Previous
            </>
        :   <>
                Next <ChevronRight />
            </>;
    if (!id) {
        return (
            <Button
                variant="outline"
                size="sm"
                disabled
                aria-label={label}
                data-testid={`${direction}-change`}>
                {content}
            </Button>
        );
    }
    return (
        <Button asChild variant="outline" size="sm">
            <Link
                href={`/changes/${id}`}
                aria-label={label}
                data-testid={`${direction}-change`}>
                {content}
            </Link>
        </Button>
    );
}

/** "How it was checked": the Trace of the Run that recorded this Change. */
function TraceTab({
    runId,
    record,
}: {
    runId: string;
    record: ChangeRecord | null;
}) {
    const { run } = useRun(runId);
    const steps = useRunSteps(runId);
    const planned = run ? planNote(run) : "";
    return (
        <div className="space-y-3">
            {run ?
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <MacroStatusPill status={run.macro_status} showOk />
                    {planned ?
                        <span>{planned}</span>
                    :   null}
                    <Link
                        href={`/monitor-runs/${runId}`}
                        className="underline underline-offset-2">
                        Open this Run
                    </Link>
                </div>
            :   null}
            <RunTrace
                steps={steps.steps}
                isLoading={steps.isLoading}
                agent={record?.agent}
                tokens={
                    run ? { input: run.input_tokens, output: run.output_tokens }
                    : record?.agent ?
                        {
                            input: record.agent.input_tokens,
                            output: record.agent.output_tokens,
                        }
                    :   null
                }
                emptyText={
                    record?.agent?.unavailable ?
                        "The model could not be reached, so nothing was looked at more closely."
                    :   "No steps were recorded for this Run: there was no pre-scraping to replay, and the agent answered from the differences alone."
                }
            />
        </div>
    );
}

export function ChangeView({ id }: { id: string }) {
    return (
        <ChangeDataProvider>
            <ChangeViewInner id={id} />
        </ChangeDataProvider>
    );
}

function ChangeViewInner({ id }: { id: string }) {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const { row, isLoading: rowLoading, error: rowError } = useChangeRow(id);
    const {
        record,
        isLoading: recordLoading,
        error: recordError,
    } = useChangeRecord(row?.record_key);
    const { monitor } = useChangeMonitor(row?.monitor_id);
    const neighbours = useChangeNeighbours(row);
    const { setFeedback, saveInstructions, ignoreSection } = useChangeMutations(
        id,
        row?.monitor_id ?? null,
    );

    const [tab, setTab] = React.useState<Tab>("what");
    const [focus, setFocus] = React.useState<Focus | null>(null);
    const [comparison, setComparison] = React.useState<ChangeRecord | null>(
        null,
    );
    // A notification's "this was Noise" link lands here with
    // ?feedback=noise: the editor starts open, and the parameter is dropped
    // so a reload or a shared link does not open it again.
    const wantsNoise = searchParams.get("feedback") === "noise";
    const [ignoring, setIgnoring] = React.useState(wantsNoise);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [baselinePending, setBaselinePending] = React.useState(false);
    const [baselineAccepted, setBaselineAccepted] = React.useState(false);

    useMarkViewed(row);

    React.useEffect(() => {
        if (!wantsNoise) return;
        replaceQuery(pathname, params => params.delete("feedback"));
    }, [wantsNoise, pathname]);

    const locate = React.useCallback<Locate>(target => {
        setFocus(current => ({
            ...target,
            nonce: (current?.nonce ?? 0) + 1,
        }));
        setTab("side");
    }, []);

    if (rowLoading) return <PageSkeleton />;
    if (rowError) {
        return (
            <Message title="This Change could not be loaded">
                {rowError}
            </Message>
        );
    }
    if (!row) {
        return (
            <Message title="Change not found">
                It may have been deleted, or it belongs to another account.
            </Message>
        );
    }

    const displayed = comparison ?? record;
    const feedback = row.user_feedback;
    const monitorName = record?.monitor.name ?? monitor?.name ?? "Monitor";
    const unavailable = !!(record?.agent ?? row.agent)?.unavailable;
    const reasons = record?.suppressed_by ?? row.suppressed_by ?? [];
    // Without a sentence from the agent, say what is known.
    const summary =
        record?.summary ||
        row.summary ||
        (unavailable ?
            "The page changed. The model could not be reached, so there is no summary."
        : reasons.includes("ignored_section") ?
            "Only parts of the page you chose to ignore changed."
        :   "The page changed.");
    const plan = monitor?.watch_plan ?? null;

    const toggleUseful = () => {
        const next = feedback === "useful" ? null : "useful";
        setFeedback.mutate(next, {
            onSuccess: () => {
                const text =
                    next ?
                        "Thanks. The agent uses this to judge later Changes."
                    :   "Feedback removed.";
                setNotice(text);
                toast.success(text);
            },
            onError: error => toast.error(error.message),
        });
    };

    const acceptBaseline = async () => {
        setBaselinePending(true);
        try {
            const result = await acceptBaselineAction(
                row.monitor_id,
                record?.to.run_id ?? row.run_id,
            );
            if (!result.ok) {
                toast.error(result.error);
                setNotice(
                    `This Capture was not made the Baseline: ${result.error}`,
                );
                return;
            }
            setBaselineAccepted(true);
            const text =
                "This Capture is now the Baseline. The next Run is compared with it.";
            setNotice(text);
            toast.success(text);
        } finally {
            setBaselinePending(false);
        }
    };

    const ignoreError =
        saveInstructions.error?.message ?? ignoreSection.error?.message ?? null;

    const textCount = countedOps(displayed?.text).length;

    return (
        <div className="mx-auto w-full max-w-5xl min-w-0 space-y-5 p-4 py-6 sm:p-6">
            <header className="min-w-0 space-y-4">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <nav
                        aria-label="Breadcrumb"
                        className="text-muted-foreground flex min-w-0 items-center gap-1 text-sm">
                        <Link
                            href={`/monitors/${row.monitor_id}?tab=changes`}
                            className="hover:text-foreground truncate underline-offset-4 hover:underline"
                            data-testid="monitor-link">
                            {monitorName}
                        </Link>
                        <ChevronRight className="size-3.5 shrink-0" />
                        <span className="shrink-0">Change</span>
                    </nav>
                    <div className="flex shrink-0 gap-2">
                        <NeighbourLink id={neighbours.prev} direction="prev" />
                        <NeighbourLink id={neighbours.next} direction="next" />
                    </div>
                </div>

                <div className="min-w-0 space-y-2">
                    <h1
                        data-testid="change-summary"
                        className="text-2xl leading-snug font-semibold tracking-tight break-words sm:text-3xl sm:leading-tight">
                        {summary}
                    </h1>
                    {(
                        row.status === "noise" &&
                        reasons.some(reason => reason !== "ignored_section")
                    ) ?
                        <p className="text-muted-foreground text-sm">
                            Not reported:{" "}
                            {reasons
                                .filter(reason => reason !== "ignored_section")
                                .map(suppressionCopy)
                                .join(" ")}
                        </p>
                    : row.status === "pending" ?
                        <p className="text-muted-foreground text-sm">
                            Waiting for the next Run to confirm it is still
                            there before telling you.
                        </p>
                    :   null}
                    {record ?
                        <p className="text-muted-foreground text-sm">
                            Captured{" "}
                            <time dateTime={record.to.at}>
                                {when(record.to.at)}
                            </time>
                            , compared with the Capture from{" "}
                            <time dateTime={record.from.at}>
                                {when(record.from.at)}
                            </time>
                            .
                        </p>
                    :   <p className="text-muted-foreground text-sm">
                            Captured {when(row.created_at)}.
                        </p>
                    }
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant={
                            feedback === "useful" ? "secondary" : "outline"
                        }
                        size="sm"
                        aria-pressed={feedback === "useful"}
                        data-testid="this-was-useful"
                        disabled={setFeedback.isPending}
                        onClick={toggleUseful}>
                        {setFeedback.isPending ?
                            <LoaderCircle className="animate-spin" />
                        :   <ThumbsUp
                                className={
                                    feedback === "useful" ? "fill-current" : (
                                        undefined
                                    )
                                }
                            />
                        }
                        This was useful
                    </Button>

                    <Button
                        variant={ignoring ? "secondary" : "outline"}
                        size="sm"
                        aria-expanded={ignoring}
                        data-testid="ignore-like-this"
                        disabled={!monitor}
                        onClick={() => setIgnoring(open => !open)}>
                        <BellOff />
                        Ignore changes like this
                    </Button>

                    <AlertDialog>
                        <AlertDialogTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                data-testid="accept-baseline"
                                disabled={baselinePending || baselineAccepted}>
                                {baselinePending ?
                                    <LoaderCircle className="animate-spin" />
                                :   null}
                                {baselineAccepted ?
                                    "This is the Baseline now"
                                :   "Use this as the baseline"}
                            </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    Use this Capture as the Baseline?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                    Later Runs are compared with the Capture
                                    from{" "}
                                    {record ? when(record.to.at) : "this Run"},
                                    and notifications show what changed since
                                    it.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                    onClick={() => void acceptBaseline()}>
                                    Use it as the Baseline
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>

                    {record ?
                        <CompareDialog
                            monitorId={row.monitor_id}
                            fromRunId={record.from.run_id}
                            toRunId={record.to.run_id}
                            onCompared={next => {
                                setComparison(next);
                                setTab("what");
                                setFocus(null);
                            }}
                        />
                    :   null}
                </div>

                <div aria-live="polite" className="space-y-1 text-sm">
                    {feedback === "noise" ?
                        <p
                            className="text-muted-foreground"
                            data-testid="noise-state">
                            You marked this Change as Noise.{" "}
                            <button
                                type="button"
                                className="text-foreground underline underline-offset-2"
                                onClick={() =>
                                    setFeedback.mutate(null, {
                                        onError: error =>
                                            toast.error(error.message),
                                    })
                                }>
                                Undo
                            </button>
                        </p>
                    :   null}
                    {notice ?
                        <p className="text-muted-foreground">{notice}</p>
                    :   null}
                </div>

                {ignoring && monitor ?
                    <IgnoreEditor
                        key={record ? "record" : "row"}
                        record={record}
                        summary={summary}
                        monitor={monitor}
                        isSaving={
                            saveInstructions.isPending ||
                            ignoreSection.isPending
                        }
                        error={ignoreError}
                        onCancel={() => {
                            setIgnoring(false);
                            saveInstructions.reset();
                            ignoreSection.reset();
                        }}
                        onSaveInstructions={instructions =>
                            saveInstructions.mutate(instructions, {
                                onSuccess: () => {
                                    setIgnoring(false);
                                    const text =
                                        "Instructions saved. They apply from the next Run.";
                                    setNotice(text);
                                    toast.success(text);
                                },
                            })
                        }
                        onIgnoreSection={(sectionId, name) =>
                            ignoreSection.mutate(sectionId, {
                                onSuccess: () => {
                                    setIgnoring(false);
                                    const text = `Changes in ${name} will no longer be reported.`;
                                    setNotice(text);
                                    toast.success(text);
                                },
                            })
                        }
                    />
                :   null}
            </header>

            {comparison ?
                <div
                    data-testid="comparison-banner"
                    className="flex flex-col gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <p className="flex min-w-0 items-start gap-2">
                        <GitCompareArrows className="mt-0.5 size-4 shrink-0 text-sky-600" />
                        <span className="min-w-0">
                            You are looking at the differences between the
                            Captures from {when(comparison.from.at)} and{" "}
                            {when(comparison.to.at)}, not at this Change. The
                            model was not asked, so there is no summary.
                        </span>
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        className="self-start sm:self-auto"
                        onClick={() => {
                            setComparison(null);
                            setTab("what");
                            setFocus(null);
                        }}>
                        <X /> Back to this Change
                    </Button>
                </div>
            :   null}

            {displayed ?
                <Tabs
                    key={comparison ? "comparison" : "record"}
                    value={tab === "trace" && comparison ? "what" : tab}
                    onValueChange={value => setTab(value as Tab)}
                    className="min-w-0 gap-4">
                    <TabsList className="h-auto! min-h-9 w-full max-w-full flex-wrap justify-start sm:w-fit">
                        <TabsTrigger
                            value="what"
                            data-testid="tab-what"
                            className={TAB_CLASS}>
                            What changed
                            {displayed.items.length ?
                                <span className="text-muted-foreground text-xs tabular-nums">
                                    {displayed.items.length}
                                </span>
                            :   null}
                        </TabsTrigger>
                        <TabsTrigger
                            value="side"
                            data-testid="tab-side"
                            className={TAB_CLASS}>
                            Side by side
                        </TabsTrigger>
                        <TabsTrigger
                            value="text"
                            data-testid="tab-text"
                            className={TAB_CLASS}>
                            Full text
                            {textCount ?
                                <span className="text-muted-foreground text-xs tabular-nums">
                                    {textCount}
                                </span>
                            :   null}
                        </TabsTrigger>
                        {comparison ? null : (
                            <TabsTrigger
                                value="trace"
                                data-testid="tab-trace"
                                className={TAB_CLASS}>
                                How it was checked
                            </TabsTrigger>
                        )}
                    </TabsList>
                    <TabsContent value="what">
                        <ItemsTab
                            record={displayed}
                            plan={plan}
                            onLocate={locate}
                            onOpenFullText={() => setTab("text")}
                        />
                    </TabsContent>
                    <TabsContent value="side">
                        <SideBySideTab
                            record={displayed}
                            plan={plan}
                            focus={focus}
                        />
                    </TabsContent>
                    <TabsContent value="text">
                        <FullTextTab record={displayed} />
                    </TabsContent>
                    {comparison ? null : (
                        <TabsContent value="trace">
                            <TraceTab runId={row.run_id} record={record} />
                        </TabsContent>
                    )}
                </Tabs>
            : recordLoading ?
                <Skeleton className="h-80 w-full" />
            :   <div className="space-y-4">
                    <p className="text-muted-foreground rounded-lg border p-4 text-sm">
                        {recordError ??
                            "The evidence for this Change is no longer stored. Evidence is kept for a limited time; the summary above stays."}
                    </p>
                    <TraceTab runId={row.run_id} record={null} />
                </div>
            }
        </div>
    );
}
