"use client";

import { magnitudeLabel, suppressionCopy } from "@/components/monitor/format";
import { useMonitorChanges, type ChangeRow } from "@/hooks/use-monitor-changes";
import { Button } from "@watchthatsite/ui/components/button";
import { cn } from "@watchthatsite/ui/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import React from "react";

const PAGE_SIZE = 20;

/** The Monitor's Changes, newest first. */
export function ChangesList({ monitorId }: { monitorId: string }) {
    const [page, setPage] = React.useState(1);
    const { changes, count, isLoading, isFetching, error } = useMonitorChanges({
        monitorId,
        includeSuppressed: false,
        page,
        pageSize: PAGE_SIZE,
    });
    const pageCount = Math.max(1, Math.ceil(count / PAGE_SIZE));

    return (
        <section aria-label="Changes" className="space-y-3">
            <h2 className="text-lg font-medium">Changes</h2>

            {error ?
                <p role="alert" className="text-destructive text-sm">
                    The Changes could not be loaded: {error.message}
                </p>
            : isLoading ?
                <p className="text-muted-foreground py-8 text-center text-sm">
                    Loading Changes…
                </p>
            : changes.length === 0 ?
                <p className="text-muted-foreground rounded-md border border-dashed px-4 py-10 text-center text-sm">
                    No Changes yet. When the page changes in a way your
                    instructions ask about, it shows up here.
                </p>
            :   <ul className={cn("space-y-2", isFetching && "opacity-70")}>
                    {changes.map(change => (
                        <li key={change.id}>
                            <ChangeCard change={change} />
                        </li>
                    ))}
                </ul>
            }

            {count > PAGE_SIZE ?
                <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-sm">
                        Page {page} of {pageCount} · {count} in all
                    </span>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page === 1}
                            onClick={() => setPage(p => Math.max(1, p - 1))}>
                            <ArrowLeft className="size-4" />
                            Newer
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={page >= pageCount}
                            onClick={() => setPage(p => p + 1)}>
                            Older
                            <ArrowRight className="size-4" />
                        </Button>
                    </div>
                </div>
            :   null}
        </section>
    );
}

/** Whether the owner was told, in a few words. */
export function sentLabel(
    change: Pick<ChangeRow, "status" | "notified_at">,
): string {
    if (change.notified_at) {
        return `Sent ${formatDistanceToNow(new Date(change.notified_at), { addSuffix: true })}`;
    }
    if (change.status === "pending") return "Not sent: waiting to confirm";
    if (change.status === "noise") return "Not sent";
    return "Not sent yet";
}

export function ChangeCard({
    change,
    monitorName,
}: {
    change: ChangeRow;
    /** Shown above the summary on lists that span Monitors. */
    monitorName?: string;
}) {
    const magnitude = magnitudeLabel(change.magnitude);
    const created = new Date(change.created_at);
    const unread = !change.viewed_at && change.status === "change";
    return (
        <Link
            href={`/changes/${change.id}`}
            data-testid="change-card"
            data-status={change.status}
            className={cn(
                "hover:bg-muted/40 focus-visible:ring-ring/50 block min-w-0 space-y-1.5 rounded-lg border p-3 transition-colors outline-none focus-visible:ring-[3px]",
                change.status === "noise" && "border-dashed",
            )}>
            {monitorName ?
                <p className="text-muted-foreground truncate text-xs">
                    {monitorName}
                </p>
            :   null}
            <p
                className={cn(
                    "line-clamp-3 text-sm break-words",
                    unread ? "font-semibold" : "font-medium",
                    change.status === "noise" && "text-muted-foreground",
                )}>
                {unread ?
                    <span
                        aria-label="Not opened yet"
                        className="bg-primary mr-1.5 inline-block size-2 rounded-full align-middle"
                    />
                :   null}
                {change.summary ||
                    (change.agent?.unavailable ?
                        "The page changed. The model could not be reached, so there is no summary."
                    : change.suppressed_by.includes("ignored_section") ?
                        "Only parts of the page you chose to ignore changed."
                    :   "The page changed.")}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">
                {magnitude ? `${magnitude} · ` : ""}
                <time
                    dateTime={change.created_at}
                    title={created.toLocaleString()}>
                    {formatDistanceToNow(created, { addSuffix: true })}
                </time>{" "}
                · {sentLabel(change)}
                {change.status === "noise" && change.suppressed_by.length ?
                    ` · ${change.suppressed_by.map(suppressionCopy).join(" ")}`
                :   ""}
            </p>
        </Link>
    );
}
