"use client";

import {
    RUN_KIND_LABEL,
    VERDICT_LABEL,
    formatDateTime,
    formatDuration,
    formatTokens,
} from "@/components/monitor/format";
import { MacroStatusPill, RunOutcomePill } from "@/components/monitor/pills";
import {
    isRunning,
    useMonitorRuns,
    type MonitorRun,
    type MonitorRunStatus,
    type RunFilters,
} from "@/hooks/use-monitor-runs";
import { useMonitors } from "@/hooks/use-monitors";
import type { RunVerdict } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@watchthatsite/ui/components/dropdown-menu";
import { Label } from "@watchthatsite/ui/components/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@watchthatsite/ui/components/table";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, ArrowRight, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import React from "react";
import { TimelineRow } from "./page/run-timeline";
import { planNote, runSummary } from "./run-copy";

/**
 * Runs across every Monitor: what each one concluded, how its Macro went,
 * what it cost in tokens, and a link to its Trace. Every filter runs in
 * PostgREST.
 */

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: MonitorRunStatus; label: string }[] = [
    { value: "pending", label: "Queued" },
    { value: "processing", label: "Running" },
    { value: "succeeded", label: "Finished" },
    { value: "failed", label: "Failed" },
];
const VERDICT_OPTIONS: RunVerdict[] = [
    "change",
    "noise",
    "pending",
    "none",
    "baseline",
];

function duration(run: MonitorRun): string {
    if (isRunning(run)) return "—";
    return formatDuration(
        new Date(run.updated_at).getTime() - new Date(run.created_at).getTime(),
    );
}

function FilterSelect<T extends string>({
    id,
    label,
    value,
    onChange,
    options,
}: {
    id: string;
    label: string;
    value: T | "all";
    onChange: (value: T | "all") => void;
    options: { value: T; label: string }[];
}) {
    return (
        <div className="min-w-0 space-y-1.5">
            <Label htmlFor={id} className="text-muted-foreground text-xs">
                {label}
            </Label>
            <Select value={value} onValueChange={v => onChange(v as T | "all")}>
                <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {options.map(o => (
                        <SelectItem key={o.value} value={o.value}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

/** When a Run started: "5 minutes ago" within a day, else the date and time. */
function startedLabel(iso: string): string {
    const at = new Date(iso);
    return Date.now() - at.getTime() < 24 * 60 * 60 * 1000 ?
            formatDistanceToNow(at, { addSuffix: true })
        :   formatDateTime(iso);
}

export function MonitorRunsTable() {
    const [filters, setFilters] = React.useState<Required<RunFilters>>({
        status: "all",
        verdict: "all",
        monitorId: "all",
    });
    const [page, setPage] = React.useState(1);
    const runsQuery = useMonitorRuns({ page, pageSize: PAGE_SIZE, filters });
    const { monitors } = useMonitors({ pageSize: 200 });
    const pageCount = Math.ceil(runsQuery.count / PAGE_SIZE) || 1;

    function setFilter<K extends keyof RunFilters>(
        key: K,
        value: Required<RunFilters>[K],
    ) {
        setFilters(f => ({ ...f, [key]: value }));
        setPage(1);
    }

    return (
        <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 p-4 py-6 sm:p-6">
            <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>

            <div className="grid gap-3 sm:grid-cols-3">
                <FilterSelect
                    id="runs-monitor"
                    label="Monitor"
                    value={filters.monitorId}
                    onChange={v => setFilter("monitorId", v)}
                    options={monitors.map(m => ({
                        value: m.id,
                        label: m.name,
                    }))}
                />
                <FilterSelect
                    id="runs-status"
                    label="Status"
                    value={filters.status}
                    onChange={v => setFilter("status", v)}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="runs-verdict"
                    label="Verdict"
                    value={filters.verdict}
                    onChange={v => setFilter("verdict", v)}
                    options={VERDICT_OPTIONS.map(v => ({
                        value: v,
                        label: VERDICT_LABEL[v],
                    }))}
                />
            </div>

            {runsQuery.error ?
                <p role="alert" className="text-destructive text-sm">
                    The Runs could not be loaded: {runsQuery.error.message}
                </p>
            :   null}

            {/* A seven-column table cannot fit a phone: there the same Runs
                are shown as the rows the Monitor page's timeline uses. */}
            <ol
                data-testid="runs-list"
                className="divide-y overflow-hidden rounded-lg border md:hidden">
                {runsQuery.isLoading ?
                    <li className="text-muted-foreground px-3 py-8 text-center text-sm">
                        Loading Runs…
                    </li>
                : runsQuery.runs.length === 0 ?
                    <li className="text-muted-foreground px-3 py-8 text-center text-sm">
                        No Runs match.
                    </li>
                :   runsQuery.runs.map(run => (
                        <TimelineRow
                            key={run.id}
                            run={run}
                            monitorName={run.monitor?.name ?? "Deleted Monitor"}
                        />
                    ))
                }
            </ol>

            <div className="bg-background hidden overflow-x-auto rounded-md border md:block">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-muted/50">
                            <TableHead>Monitor</TableHead>
                            <TableHead>Verdict</TableHead>
                            <TableHead>Summary</TableHead>
                            <TableHead>Pre-scraping</TableHead>
                            <TableHead className="text-right">Tokens</TableHead>
                            <TableHead>Started</TableHead>
                            <TableHead>
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {runsQuery.isLoading ?
                            <TableRow>
                                <TableCell
                                    colSpan={7}
                                    className="h-24 text-center">
                                    Loading Runs…
                                </TableCell>
                            </TableRow>
                        : runsQuery.runs.length === 0 ?
                            <TableRow>
                                <TableCell
                                    colSpan={7}
                                    className="h-24 text-center">
                                    No Runs match.
                                </TableCell>
                            </TableRow>
                        :   runsQuery.runs.map(run => {
                                const summary = runSummary(run);
                                const planned = planNote(run);
                                const change = run.changes?.[0];
                                return (
                                    <TableRow
                                        key={run.id}
                                        data-testid="run-row">
                                        <TableCell>
                                            <div className="max-w-[220px] min-w-[150px] space-y-0.5">
                                                <Link
                                                    href={`/monitors/${run.monitor_id}`}
                                                    className="block truncate font-medium hover:underline">
                                                    {run.monitor?.name ??
                                                        "Deleted Monitor"}
                                                </Link>
                                                <p className="text-muted-foreground text-xs">
                                                    {RUN_KIND_LABEL[
                                                        run.trigger
                                                    ] ?? run.trigger}{" "}
                                                    · {duration(run)}
                                                </p>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <RunOutcomePill
                                                status={run.status}
                                                verdict={run.verdict}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <div className="max-w-[360px] min-w-[200px] space-y-0.5 whitespace-normal">
                                                <p
                                                    title={summary}
                                                    className={
                                                        (
                                                            run.status ===
                                                            "failed"
                                                        ) ?
                                                            "text-destructive line-clamp-2 text-sm"
                                                        : (
                                                            run.verdict ===
                                                            "none"
                                                        ) ?
                                                            "text-muted-foreground line-clamp-2 text-sm"
                                                        :   "line-clamp-2 text-sm"

                                                    }>
                                                    {change ?
                                                        <Link
                                                            href={`/changes/${change.id}`}
                                                            className="hover:underline">
                                                            {summary}
                                                        </Link>
                                                    :   summary}
                                                </p>
                                                {planned ?
                                                    <p className="text-muted-foreground text-xs">
                                                        {planned}
                                                    </p>
                                                :   null}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {run.macro_status ?
                                                <MacroStatusPill
                                                    status={run.macro_status}
                                                    showOk
                                                />
                                            :   <span className="text-muted-foreground">
                                                    —
                                                </span>
                                            }
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-right whitespace-nowrap tabular-nums">
                                            {formatTokens(
                                                run.input_tokens,
                                                run.output_tokens,
                                            ).replace(" tokens", "") || "—"}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground whitespace-nowrap">
                                            <time
                                                dateTime={run.created_at}
                                                title={formatDateTime(
                                                    run.created_at,
                                                )}>
                                                {startedLabel(run.created_at)}
                                            </time>
                                        </TableCell>
                                        <TableCell className="w-10">
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon-sm">
                                                        <MoreHorizontal className="size-4" />
                                                        <span className="sr-only">
                                                            Actions
                                                        </span>
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem asChild>
                                                        <Link
                                                            href={`/monitor-runs/${run.id}`}>
                                                            Open the Trace
                                                        </Link>
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </TableCell>
                                    </TableRow>
                                );
                            })
                        }
                    </TableBody>
                </Table>
            </div>

            <div className="flex items-center justify-between gap-2">
                <div className="text-muted-foreground text-sm">
                    Page {page} of {pageCount}
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1 || runsQuery.isLoading}>
                        <ArrowLeft className="size-4" />
                        Newer
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => p + 1)}
                        disabled={runsQuery.isLoading || page >= pageCount}>
                        Older
                        <ArrowRight className="size-4" />
                    </Button>
                </div>
            </div>
        </main>
    );
}
