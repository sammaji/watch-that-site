"use client";

import { ObjectImage } from "@/components/change/object-image";
import { formatDateTime, formatDuration } from "@/components/monitor/format";
import { runSummary } from "@/components/monitor/run-copy";
import { RunTrace } from "@/components/monitor/run-trace";
import { isRunning, useCapture, useRun } from "@/hooks/use-monitor-runs";
import { useRunSteps } from "@/hooks/use-run-steps";
import { Button } from "@watchthatsite/ui/components/button";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function RunPage({ id }: { id: string }) {
    const valid = UUID.test(id);
    const { run, isLoading, error } = useRun(valid ? id : undefined);
    const running = !!run && isRunning(run);
    const steps = useRunSteps(run?.id, running);
    const { capture } = useCapture(run?.status === "succeeded" ? run.id : null);

    if (valid && isLoading) {
        return (
            <div className="text-muted-foreground flex h-64 items-center justify-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin" />
                Loading the Run…
            </div>
        );
    }
    if (!valid || error || !run) {
        return (
            <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-3 text-sm">
                {error?.message ?? "Run not found."}
                <Link
                    href="/monitor-runs"
                    className="underline underline-offset-2">
                    All Runs
                </Link>
            </div>
        );
    }

    const change = run.changes?.[0];
    const quiet =
        run.status === "succeeded" &&
        (run.verdict === "none" || run.verdict === "baseline");

    return (
        <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6 p-4 py-6 sm:p-6">
            <header className="min-w-0 space-y-3">
                <Link
                    href={`/monitors/${run.monitor_id}`}
                    className="text-muted-foreground hover:text-foreground flex w-fit max-w-full items-center gap-1 text-sm">
                    <ArrowLeft className="size-4 shrink-0" />
                    <span className="truncate">
                        {run.monitor?.name ?? "Monitor"}
                    </span>
                </Link>
                <h1
                    className="text-xl font-semibold tracking-tight break-words sm:text-2xl"
                    data-testid="run-summary">
                    {runSummary(run)}
                </h1>
                <p className="text-muted-foreground text-sm">
                    <time dateTime={run.created_at}>
                        {formatDateTime(run.created_at)}
                    </time>
                    {running ?
                        ""
                    :   ` · took ${formatDuration(
                            new Date(run.updated_at).getTime() -
                                new Date(run.created_at).getTime(),
                        )}`
                    }
                </p>
                {change ?
                    <Button asChild variant="outline" size="sm">
                        <Link href={`/changes/${change.id}`}>
                            Open the Change <ArrowRight />
                        </Link>
                    </Button>
                :   null}
            </header>

            <section className="space-y-3">
                <h2 className="text-lg font-medium">How it was checked</h2>
                <RunTrace
                    steps={steps.steps}
                    isLoading={steps.isLoading}
                    agent={change?.agent}
                    tokens={{
                        input: run.input_tokens,
                        output: run.output_tokens,
                    }}
                    emptyText={
                        running ?
                            "The Run has just started. Its steps appear here as they happen."
                        : quiet ?
                            "The page was captured without pre-scraping and nothing needed a closer look, so no model was called."
                        :   "Nothing was recorded for this Run."
                    }
                />
            </section>

            {capture?.screenshot_key ?
                <section className="space-y-3">
                    <h2 className="text-lg font-medium">The Capture</h2>
                    <div className="bg-muted/30 max-h-[70vh] overflow-y-auto rounded-md border">
                        <ObjectImage
                            objectKey={capture.screenshot_key}
                            alt="The Capture's screenshot"
                        />
                    </div>
                </section>
            :   null}
        </main>
    );
}
