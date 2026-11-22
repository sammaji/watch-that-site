"use client";

import { compareAction } from "@/app/actions/scheduler";
import { useMonitorCaptures } from "@/hooks/use-change";
import type { ChangeRecord } from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@watchthatsite/ui/components/dialog";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import { cn } from "@watchthatsite/ui/lib/utils";
import { format } from "date-fns";
import { GitCompareArrows, LoaderCircle } from "lucide-react";
import * as React from "react";

/**
 * Pick any two of the Monitor's recent Captures and show the scheduler's
 * on-demand comparison of them. Nothing is stored and no model is called, so
 * the result is the differences without an agent answer.
 */
export function CompareDialog({
    monitorId,
    fromRunId,
    toRunId,
    onCompared,
}: {
    monitorId: string;
    fromRunId: string;
    toRunId: string;
    onCompared: (record: ChangeRecord) => void;
}) {
    const [open, setOpen] = React.useState(false);
    const [picked, setPicked] = React.useState<string[]>([]);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const {
        captures,
        isLoading,
        error: loadError,
    } = useMonitorCaptures(monitorId, open);

    const toggle = (runId: string) => {
        setError(null);
        setPicked(current =>
            current.includes(runId) ? current.filter(id => id !== runId)
            : current.length >= 2 ? [current[1]!, runId]
            : [...current, runId],
        );
    };

    const run = async () => {
        if (picked.length !== 2) return;
        // Older capture first, whatever order they were ticked in.
        const ordered = captures
            .filter(c => picked.includes(c.run_id))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        setPending(true);
        setError(null);
        try {
            const result = await compareAction(
                monitorId,
                ordered[0]!.run_id,
                ordered[1]!.run_id,
            );
            if (!result.ok) {
                setError(result.error);
                return;
            }
            onCompared(result.data);
            setOpen(false);
        } catch (err) {
            setError(
                err instanceof Error ?
                    err.message
                :   "The Captures could not be compared. Try again.",
            );
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                setOpen(next);
                if (next) setPicked([]);
            }}>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" data-testid="compare">
                    <GitCompareArrows />
                    Compare two Captures
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Compare two Captures</DialogTitle>
                    <DialogDescription>
                        Pick any two Captures of this Monitor. You get the
                        differences between them; the model is not asked, and
                        nothing is saved.
                    </DialogDescription>
                </DialogHeader>
                <div className="max-h-[50vh] min-w-0 overflow-y-auto rounded-md border">
                    {isLoading ?
                        <div className="space-y-2 p-3">
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-full" />
                        </div>
                    : loadError ?
                        <p className="text-destructive p-3 text-sm">
                            {loadError}
                        </p>
                    : captures.length < 2 ?
                        <p className="text-muted-foreground p-3 text-sm">
                            This Monitor needs at least two stored Captures to
                            compare.
                        </p>
                    :   <ul className="divide-y" aria-label="Captures">
                            {captures.map(capture => {
                                const checked = picked.includes(capture.run_id);
                                const id = `capture-${capture.run_id}`;
                                return (
                                    <li key={capture.run_id}>
                                        <label
                                            htmlFor={id}
                                            className={cn(
                                                "hover:bg-muted/60 flex cursor-pointer items-center gap-3 px-3 py-2 text-sm",
                                                checked && "bg-muted",
                                            )}>
                                            <input
                                                id={id}
                                                type="checkbox"
                                                className="accent-primary size-4"
                                                checked={checked}
                                                onChange={() =>
                                                    toggle(capture.run_id)
                                                }
                                            />
                                            <span className="min-w-0 flex-1 truncate tabular-nums">
                                                {format(
                                                    new Date(
                                                        capture.created_at,
                                                    ),
                                                    "PP p",
                                                )}
                                            </span>
                                            {capture.run_id === fromRunId ?
                                                <Badge variant="outline">
                                                    before
                                                </Badge>
                                            : capture.run_id === toRunId ?
                                                <Badge variant="outline">
                                                    after
                                                </Badge>
                                            :   null}
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    }
                </div>
                {error ?
                    <p className="text-destructive text-sm">{error}</p>
                :   null}
                <DialogFooter>
                    <p className="text-muted-foreground mr-auto self-center text-xs">
                        {picked.length} of 2 chosen
                    </p>
                    <Button
                        onClick={run}
                        disabled={picked.length !== 2 || pending}
                        data-testid="compare-run">
                        {pending ?
                            <LoaderCircle className="animate-spin" />
                        :   null}
                        Compare these two
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
