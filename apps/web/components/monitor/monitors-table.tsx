"use client";

import { formatInterval } from "@/components/monitor/format";
import {
    useMonitors,
    type Monitor,
    type MonitorStatus,
} from "@/hooks/use-monitors";
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    useReactTable,
} from "@tanstack/react-table";
import { DEFAULT_INSTRUCTIONS } from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import { Button } from "@watchthatsite/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@watchthatsite/ui/components/dropdown-menu";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@watchthatsite/ui/components/table";
import { cn } from "@watchthatsite/ui/lib/utils";
import {
    ArrowLeft,
    ArrowRight,
    Filter,
    MoreHorizontal,
    Plus,
    Search,
    Trash2,
} from "lucide-react";
import Link from "next/link";
import React from "react";

const columnHelper = createColumnHelper<Monitor>();

const statusOptions: MonitorStatus[] = ["active", "paused"];

function formatDate(value: string | null) {
    if (!value) return "Not scheduled";

    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(new Date(value));
}

/** Columns a phone has no room for; the Monitor page shows the same facts. */
const PHONE_HIDDEN = "hidden md:table-cell";

function columnClass(meta: unknown): string | undefined {
    return (meta as { className?: string } | undefined)?.className;
}

const columns = [
    columnHelper.accessor("name", {
        header: "Name",
        cell: ({ row, getValue }) => (
            <div className="max-w-[420px] min-w-[150px] space-y-1 max-md:max-w-[200px]">
                <Link
                    href={`/monitors/${row.original.id}`}
                    className="font-medium hover:underline">
                    {getValue()}
                </Link>
                <p className="text-muted-foreground truncate font-mono text-xs">
                    {row.original.url}
                </p>
            </div>
        ),
    }),
    columnHelper.accessor("instructions", {
        header: "Instructions",
        meta: { className: PHONE_HIDDEN },
        cell: ({ getValue }) => {
            const instructions = getValue()?.trim();
            return (
                <p
                    title={instructions || DEFAULT_INSTRUCTIONS}
                    className={
                        instructions ?
                            "line-clamp-2 max-w-[360px] min-w-[200px] text-sm whitespace-normal"
                        :   "text-muted-foreground line-clamp-2 max-w-[360px] min-w-[200px] text-sm whitespace-normal"
                    }>
                    {instructions || "Any meaningful change"}
                </p>
            );
        },
    }),
    columnHelper.accessor("status", {
        header: "Status",
        cell: ({ getValue }) => (
            <Badge variant="secondary" className="capitalize">
                {getValue()}
            </Badge>
        ),
    }),
    columnHelper.accessor("interval_minutes", {
        header: "How often",
        meta: { className: PHONE_HIDDEN },
        cell: ({ getValue }) => {
            const value = getValue();
            return (
                <span className="text-muted-foreground">
                    {formatInterval(value)}
                </span>
            );
        },
    }),
    columnHelper.accessor("updated_at", {
        header: "Updated",
        meta: { className: PHONE_HIDDEN },
        cell: ({ getValue }) => (
            <span className="text-muted-foreground">
                {formatDate(getValue())}
            </span>
        ),
    }),
    columnHelper.display({
        id: "actions",
        cell: ({ row, table }) => {
            const meta = table.options.meta as MonitorsTableMeta;
            const monitor = row.original;

            return (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">Actions</span>
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                            <Link href={`/monitors/${monitor.id}`}>Open</Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                            <Link href={`/monitors/edit/${monitor.id}`}>
                                Edit
                            </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => meta.onToggleStatus(monitor)}>
                            {monitor.status === "active" ? "Pause" : "Resume"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={() => meta.onDelete(monitor)}>
                            <Trash2 className="size-4" />
                            Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            );
        },
    }),
];

type MonitorsTableMeta = {
    onToggleStatus: (monitor: Monitor) => void;
    onDelete: (monitor: Monitor) => void;
};

export function MonitorsTable() {
    const [search, setSearch] = React.useState("");
    const [statusFilter, setStatusFilter] = React.useState<MonitorStatus[]>([]);
    const [updatedFrom, setUpdatedFrom] = React.useState("");
    const [updatedTo, setUpdatedTo] = React.useState("");
    const [page, setPage] = React.useState(1);
    const PAGE_SIZE = 50;

    const monitorsQuery = useMonitors({ page, pageSize: PAGE_SIZE });

    const filteredData = React.useMemo(() => {
        return monitorsQuery.monitors.filter(monitor => {
            if (
                statusFilter.length > 0 &&
                !statusFilter.includes(monitor.status)
            ) {
                return false;
            }

            if (updatedFrom) {
                const from = new Date(`${updatedFrom}T00:00:00`);
                if (new Date(monitor.updated_at) < from) return false;
            }

            if (updatedTo) {
                const to = new Date(`${updatedTo}T23:59:59.999`);
                if (new Date(monitor.updated_at) > to) return false;
            }

            return true;
        });
    }, [monitorsQuery.monitors, statusFilter, updatedFrom, updatedTo]);

    const meta = React.useMemo<MonitorsTableMeta>(
        () => ({
            onToggleStatus: monitor =>
                monitorsQuery.setMonitorStatus({
                    id: monitor.id,
                    status: monitor.status === "active" ? "paused" : "active",
                }),
            onDelete: monitor => {
                if (
                    !window.confirm(
                        `Delete the Monitor “${monitor.name}” with its Runs, Changes, pre-scraping and secrets? This cannot be undone.`,
                    )
                ) {
                    return;
                }
                monitorsQuery.deleteMonitor(monitor.id);
            },
        }),
        [monitorsQuery],
    );

    const table = useReactTable({
        data: filteredData,
        columns,
        state: {
            globalFilter: search,
        },
        meta,
        onGlobalFilterChange: setSearch,
        getCoreRowModel: getCoreRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
    });

    return (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 py-6 sm:p-6">
            <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div>
                    <h1 className="text-2xl font-semibold tracking-normal">
                        Monitors
                    </h1>
                </div>
            </section>

            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1 sm:max-w-sm">
                        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                        <Input
                            className="pl-8"
                            placeholder="Search Monitors"
                            value={search}
                            onChange={event => setSearch(event.target.value)}
                        />
                    </div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="outline"
                                size="icon"
                                aria-label="Filter Monitors">
                                <Filter className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuLabel>Status</DropdownMenuLabel>
                            {statusOptions.map(status => (
                                <DropdownMenuCheckboxItem
                                    checked={statusFilter.includes(status)}
                                    key={status}
                                    onCheckedChange={checked => {
                                        setStatusFilter(current =>
                                            checked ?
                                                [...current, status]
                                            :   current.filter(
                                                    item => item !== status,
                                                ),
                                        );
                                    }}>
                                    <span className="capitalize">{status}</span>
                                </DropdownMenuCheckboxItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>Date</DropdownMenuLabel>
                            <div className="space-y-3 px-2 pb-2">
                                <Label
                                    htmlFor="updated-from"
                                    className="text-muted-foreground text-xs">
                                    Updated from
                                </Label>
                                <Input
                                    id="updated-from"
                                    type="date"
                                    value={updatedFrom}
                                    onChange={event =>
                                        setUpdatedFrom(event.target.value)
                                    }
                                />
                                <Label
                                    htmlFor="updated-to"
                                    className="text-muted-foreground text-xs">
                                    Updated to
                                </Label>
                                <Input
                                    id="updated-to"
                                    type="date"
                                    value={updatedTo}
                                    onChange={event =>
                                        setUpdatedTo(event.target.value)
                                    }
                                />
                                <Button
                                    className="w-full"
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                        setStatusFilter([]);
                                        setUpdatedFrom("");
                                        setUpdatedTo("");
                                    }}>
                                    Clear filters
                                </Button>
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <Button asChild className="ml-auto">
                        <Link href="/monitors/create">
                            <Plus className="size-4" />
                            New Monitor
                        </Link>
                    </Button>
                </div>
            </div>

            <div className="bg-background overflow-x-auto rounded-md border">
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map(headerGroup => (
                            <TableRow
                                className="bg-muted/50"
                                key={headerGroup.id}>
                                {headerGroup.headers.map(header => (
                                    <TableHead
                                        className={cn(
                                            "h-9 py-2",
                                            columnClass(
                                                header.column.columnDef.meta,
                                            ),
                                        )}
                                        key={header.id}>
                                        {header.isPlaceholder ? null : (
                                            flexRender(
                                                header.column.columnDef.header,
                                                header.getContext(),
                                            )
                                        )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {monitorsQuery.isLoading ?
                            <TableRow>
                                <TableCell
                                    colSpan={columns.length}
                                    className="h-24 text-center">
                                    Loading Monitors…
                                </TableCell>
                            </TableRow>
                        : table.getRowModel().rows.length ?
                            table.getRowModel().rows.map(row => (
                                <TableRow key={row.id} className="h-[48px]">
                                    {row.getVisibleCells().map(cell => (
                                        <TableCell
                                            className={cn(
                                                "py-2",
                                                columnClass(
                                                    cell.column.columnDef.meta,
                                                ),
                                            )}
                                            key={cell.id}>
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        :   <TableRow>
                                <TableCell
                                    colSpan={columns.length}
                                    className="h-24 text-center">
                                    {monitorsQuery.count === 0 ?
                                        "No Monitors yet. Create one to start watching a page."
                                    :   "No Monitors match."}
                                </TableCell>
                            </TableRow>
                        }
                    </TableBody>
                </Table>
            </div>

            <div className="flex items-center justify-between">
                <div className="text-muted-foreground text-sm">
                    Page {page} of{" "}
                    {Math.ceil(monitorsQuery.count / PAGE_SIZE) || 1}
                </div>
                <div className="flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1 || monitorsQuery.isLoading}>
                        <ArrowLeft className="size-4" />
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage(p => p + 1)}
                        disabled={
                            monitorsQuery.isLoading ||
                            page >= Math.ceil(monitorsQuery.count / PAGE_SIZE)
                        }>
                        Next
                        <ArrowRight className="size-4" />
                    </Button>
                </div>
            </div>
        </main>
    );
}
