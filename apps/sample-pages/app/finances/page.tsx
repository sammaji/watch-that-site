import { getFinanceRows, Time } from "@/lib/faker";
import {
    financePageParams,
    toPositiveInterval,
    type SearchParams,
} from "@/lib/refresh-params";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@watchthatsite/ui/components/table";
import { Ellipsis } from "lucide-react";
import React from "react";

export const dynamic = "force-dynamic";

const flagMap = {
    IN: "🇮🇳",
    EU: "🇪🇺",
    US: "🇺🇸",
} as const;

function Sparkline({ points, profit }: { points: number[]; profit: number }) {
    const width = 112;
    const height = 36;
    const padding = 4;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;
    const step = (width - padding * 2) / Math.max(points.length - 1, 1);
    const stroke = profit >= 0 ? "#16a34a" : "#dc2626";

    const path = points
        .map((point, index) => {
            const x = padding + index * step;
            const y =
                height -
                padding -
                ((point - min) / range) * (height - padding * 2);
            return `${index === 0 ? "M" : "L"}${x} ${y}`;
        })
        .join(" ");

    return (
        <svg
            aria-hidden="true"
            viewBox={`0 0 ${width} ${height}`}
            className="h-9 w-28 overflow-visible">
            <path
                d={path}
                fill="none"
                stroke={stroke}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

const headers = ["Name", "Amount", "Profit", "Country", "Creator", ""];

export default async function FinancesPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    // eslint-disable-next-line react-hooks/purity -- intentionally impure: page is force-dynamic and time-driven
    const now = Date.now();
    const { amountRefreshInterval, profitRefreshInterval } =
        await financePageParams(searchParams);
    const financeRows = getFinanceRows(now, {
        amountRefreshIntervalMs: toPositiveInterval(amountRefreshInterval, Time.HOUR),
        profitRefreshIntervalMs: toPositiveInterval(
            profitRefreshInterval,
            15 * Time.MINUTE,
        ),
    });

    return (
        <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl space-y-6">
                <div className="flex items-center justify-between space-y-2">
                    <h1 className="mb-0 text-2xl tracking-tight text-slate-950">
                        Finances
                    </h1>
                    <Button>Add more</Button>
                </div>

                <section className="overflow-hidden rounded-md border border-slate-200/80 bg-white/85 backdrop-blur">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-slate-200 bg-slate-50/70 hover:bg-slate-50/70">
                                {headers.map((h, i) => (
                                    <React.Fragment key={i}>
                                        <TableHead className="px-4 py-4 text-xs tracking-[0.2em] text-slate-500 uppercase">
                                            {h}
                                        </TableHead>
                                    </React.Fragment>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {financeRows.map(row => {
                                const isPositive = row.profit >= 0;
                                return (
                                    <TableRow
                                        key={`${row.name}-${row.creator}`}
                                        className="border-slate-200/80 hover:bg-slate-50/60">
                                        <TableCell className="px-4 py-4 whitespace-normal">
                                            <div className="font-medium text-slate-950">
                                                {row.name}
                                            </div>
                                        </TableCell>
                                        <TableCell className="px-4 py-4 font-medium text-slate-700">
                                            {row.amount}
                                        </TableCell>
                                        <TableCell className="px-4 py-4">
                                            <div className="flex min-w-[220px] items-center gap-4">
                                                <span
                                                    className={
                                                        isPositive ?
                                                            "font-semibold text-green-600"
                                                        :   "font-semibold text-red-600"
                                                    }>
                                                    {isPositive ? "+" : ""}
                                                    {row.profit.toFixed(1)}%
                                                </span>
                                                <Sparkline
                                                    points={row.trend}
                                                    profit={row.profit}
                                                />
                                            </div>
                                        </TableCell>
                                        <TableCell className="px-4 py-4">
                                            <div className="flex items-center gap-3">
                                                <span
                                                    className="text-xl leading-none"
                                                    aria-hidden="true">
                                                    {flagMap[row.country.code]}
                                                </span>
                                                <div>
                                                    <div className="font-medium text-slate-900">
                                                        {row.country.code}
                                                    </div>
                                                    <div className="text-xs text-slate-500">
                                                        {row.country.label}
                                                    </div>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell className="px-4 py-4 text-slate-700">
                                            {row.creator}
                                        </TableCell>
                                        <TableCell className="px-4 py-4 text-right">
                                            <Button
                                                variant="outline"
                                                size="icon">
                                                <Ellipsis className="h-4 w-4" />
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </section>
            </div>
        </main>
    );
}
