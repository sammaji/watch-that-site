"use client";

import { useUsage, type Usage, type UsagePeriod } from "@/hooks/use-usage";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@watchthatsite/ui/components/table";
import {
    ToggleGroup,
    ToggleGroupItem,
} from "@watchthatsite/ui/components/toggle-group";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@watchthatsite/ui/components/tooltip";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import * as React from "react";
import { ColumnChart, Legend, type ChartSeries } from "./column-chart";
import styles from "./usage.module.css";

const PERIODS: { value: UsagePeriod; label: string; long: string }[] = [
    { value: "24h", label: "24 hours", long: "the last 24 hours" },
    { value: "7d", label: "7 days", long: "the last 7 days" },
    { value: "30d", label: "30 days", long: "the last 30 days" },
];

/** Fixed slot order: the credit is always slot 1, so blue always means credit. */
const SLOTS = [
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-3)",
    "var(--series-4)",
];
const MAX_COST_SERIES = 4;

function money(v: number): string {
    if (v === 0) return "$0.00";
    if (v < 0.01) return "<$0.01";
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Exact enough to tell small amounts apart: a check costs fractions of a cent. */
function preciseMoney(v: number): string {
    if (v === 0) return "$0";
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return money(v);
}

function axisMoney(v: number): string {
    if (v === 0) return "$0";
    if (v < 1) return `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
}

function compact(v: number): string {
    return Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
    }).format(v);
}

function Section({
    title,
    hint,
    action,
    children,
}: {
    title: string;
    hint?: React.ReactNode;
    /** A control at the top right, e.g. a view switch. */
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="bg-card min-w-0 space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                    <h2 className={`${styles.ink} text-sm font-semibold`}>
                        {title}
                    </h2>
                    {hint ?
                        <p className={`${styles.ink3} text-xs`}>{hint}</p>
                    :   null}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

function Card({
    label,
    value,
    detail,
    bleed,
    children,
}: {
    label: string;
    value: string;
    detail?: React.ReactNode;
    /** A figure along the card's bottom edge, touching both sides and the foot. */
    bleed?: React.ReactNode;
    /** A small figure under the number, kept at the card's foot. */
    children?: React.ReactNode;
}) {
    return (
        <div className="bg-card flex min-w-0 flex-col overflow-hidden rounded-lg border">
            <div className="flex flex-1 flex-col gap-3 p-4">
                <div className="min-w-0">
                    <p className={`${styles.ink2} text-xs`}>{label}</p>
                    <p
                        className={`${styles.ink} ${styles.num} mt-1 text-2xl font-semibold`}>
                        {value}
                    </p>
                    {detail ?
                        <p className={`${styles.ink3} mt-0.5 truncate text-xs`}>
                            {detail}
                        </p>
                    :   null}
                </div>
                {children ?
                    <div className="mt-auto space-y-2">{children}</div>
                :   null}
            </div>
            {bleed ?
                <div className="mt-auto">{bleed}</div>
            :   null}
        </div>
    );
}

/**
 * A line with a gradient fill under it, edge to edge: no axes, no padding,
 * for the shape of a trend inside a card. Hover shows each point's value.
 */
function Sparkline({
    points,
    format,
    label,
}: {
    points: { at: string; value: number; when: string }[];
    format: (v: number) => string;
    label: string;
}) {
    const id = React.useId();
    const [hover, setHover] = React.useState<number | null>(null);
    const W = 100;
    const H = 40;
    const TOP = 4;
    const max = Math.max(0, ...points.map(p => p.value));
    const x = (i: number) =>
        points.length < 2 ? W / 2 : (i / (points.length - 1)) * W;
    const y = (v: number) => (max > 0 ? TOP + (1 - v / max) * (H - TOP) : H);
    const line = points
        .map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`)
        .join(" ");
    const area =
        points.length ?
            `${line} L${x(points.length - 1)},${H} L${x(0)},${H} Z`
        :   "";
    const point = hover === null ? null : points[hover];

    return (
        <div
            className="relative h-14 w-full"
            onMouseLeave={() => setHover(null)}
            onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                const i = Math.round(
                    ((e.clientX - r.left) / r.width) * (points.length - 1),
                );
                setHover(Math.max(0, Math.min(points.length - 1, i)));
            }}>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="block h-full w-full"
                role="img"
                aria-label={label}>
                <defs>
                    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                        <stop
                            offset="0%"
                            stopColor="var(--series-1)"
                            stopOpacity={0.35}
                        />
                        <stop
                            offset="100%"
                            stopColor="var(--series-1)"
                            stopOpacity={0}
                        />
                    </linearGradient>
                </defs>
                <path d={area} fill={`url(#${id})`} />
                <path
                    d={line}
                    fill="none"
                    stroke="var(--series-1)"
                    strokeWidth={1.25}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
                {point && hover !== null ?
                    <line
                        x1={x(hover)}
                        x2={x(hover)}
                        y1={0}
                        y2={H}
                        stroke="var(--ink-3)"
                        strokeWidth={1}
                        strokeDasharray="2 2"
                        vectorEffect="non-scaling-stroke"
                    />
                :   null}
            </svg>
            {point && hover !== null ?
                <div
                    className={styles.tooltip}
                    style={{
                        // Inside the chart, so it never covers the card's text.
                        top: 2,
                        padding: "2px 6px",
                        ...(hover / Math.max(1, points.length - 1) > 0.5 ?
                            {
                                right: `${100 - (hover / Math.max(1, points.length - 1)) * 100}%`,
                            }
                        :   {
                                left: `${(hover / Math.max(1, points.length - 1)) * 100}%`,
                            }),
                        minWidth: 0,
                    }}>
                    <span className={styles.ink2}>{point.when}</span>{" "}
                    <span className="font-medium">{format(point.value)}</span>
                </div>
            :   null}
        </div>
    );
}

type Part = { label: string; value: number; color: string; display: string };

/**
 * One quantity split into parts, as a single bar: each part's share of the
 * whole, separated by a 2 px gap, with the parts named underneath.
 */
function OneBar({ parts, label }: { parts: Part[]; label: string }) {
    const total = parts.reduce((sum, p) => sum + p.value, 0);
    return (
        <>
            <div className={styles.bar} role="img" aria-label={label}>
                {total > 0 ?
                    parts
                        .filter(p => p.value > 0)
                        .map(p => (
                            <span
                                key={p.label}
                                title={`${p.label}: ${p.display}`}
                                style={{
                                    flexGrow: p.value,
                                    flexBasis: 0,
                                    minWidth: 3,
                                    background: p.color,
                                }}
                            />
                        ))
                :   <span style={{ flexGrow: 1, background: "var(--empty)" }} />
                }
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                {parts.map(p => (
                    <span
                        key={p.label}
                        className={`${styles.ink2} flex items-center gap-1.5`}>
                        <span
                            className={styles.swatch}
                            style={{ background: p.color }}
                        />
                        {p.label}
                        <span className={`${styles.ink} ${styles.num}`}>
                            {p.display}
                        </span>
                    </span>
                ))}
            </div>
        </>
    );
}

/**
 * An uptime strip: one bar per hour or day, coloured by how its calls went.
 * Green when none failed, amber when some did, red when most did, and a
 * faint bar when there were no calls.
 */
function Uptime({
    buckets,
    bucketSeconds,
}: {
    buckets: Usage["uptime"];
    bucketSeconds: number;
}) {
    const when = (at: string) =>
        new Date(at).toLocaleString(
            undefined,
            bucketSeconds < 86400 ?
                {
                    hour: "numeric",
                    minute: "2-digit",
                    day: "numeric",
                    month: "short",
                }
            :   { day: "numeric", month: "short" },
        );
    return (
        <div
            className={styles.uptime}
            role="img"
            aria-label="Model calls per period, coloured by how many failed">
            {buckets.map(b => {
                const share = b.requests ? b.failed / b.requests : 0;
                const color =
                    b.requests === 0 ? "var(--empty)"
                    : share === 0 ? "var(--good)"
                    : share < 0.5 ? "var(--warning)"
                    : "var(--critical)";
                return (
                    <span
                        key={b.at}
                        style={{ background: color }}
                        title={
                            b.requests ?
                                `${when(b.at)}: ${b.requests - b.failed} succeeded, ${b.failed} failed`
                            :   `${when(b.at)}: no calls`
                        }
                    />
                );
            })}
        </div>
    );
}

export function UsagePage() {
    const [period, setPeriod] = React.useState<UsagePeriod>("7d");
    const { data, isLoading, error } = useUsage(period);
    const long = PERIODS.find(p => p.value === period)!.long;

    const [costBy, setCostBy] = React.useState<"provider" | "model">(
        "provider",
    );

    // The cost chart's series: providers (the credit first) or models (the
    // most expensive first), in a fixed order; past four, the rest fold into
    // "Other" so no colour is ever generated.
    const costSeries: ChartSeries[] = React.useMemo(() => {
        const providerName = new Map(
            (data?.providers ?? []).map(p => [p.id, p.label] as const),
        );
        const items =
            costBy === "provider" ?
                (data?.providers ?? []).map(p => ({
                    key: p.id,
                    label: p.label,
                }))
            :   (data?.models ?? [])
                    .filter(m => m.costUsd > 0)
                    .map((m, _, all) => ({
                        key: m.key,
                        // The same model on two providers needs telling apart.
                        label:
                            all.filter(o => o.model === m.model).length > 1 ?
                                `${m.model} (${providerName.get(m.provider) ?? m.provider})`
                            :   m.model,
                    }));
        const series = items
            .slice(0, MAX_COST_SERIES)
            .map((item, i) => ({ ...item, color: SLOTS[i]! }));
        if (items.length > MAX_COST_SERIES) {
            series[MAX_COST_SERIES - 1] = {
                key: "__other",
                label: "Other",
                color: "var(--series-other)",
            };
        }
        return series;
    }, [costBy, data?.providers, data?.models]);

    const costColumns = React.useMemo(() => {
        const shown = new Set(costSeries.map(s => s.key));
        return (data?.buckets ?? []).map(b => {
            const values: Record<string, number> = {};
            const source = costBy === "provider" ? b.cost : b.modelCost;
            for (const [key, cost] of Object.entries(source)) {
                const k = shown.has(key) ? key : "__other";
                values[k] = (values[k] ?? 0) + cost;
            }
            return { at: b.at, values };
        });
    }, [data?.buckets, costSeries, costBy]);

    const requestSeries: ChartSeries[] = [
        { key: "ok", label: "Succeeded", color: "var(--series-1)" },
        { key: "failed", label: "Failed", color: "var(--critical)" },
    ];
    const tokenSeries: ChartSeries[] = [
        // The same three blues as the Tokens card: one quantity, split.
        { key: "in", label: "Input", color: "var(--blue-1)" },
        { key: "cached", label: "Cached", color: "var(--blue-2)" },
        { key: "out", label: "Output", color: "var(--blue-3)" },
    ];
    const providerLabel = new Map(
        (data?.providers ?? []).map(p => [p.id, p.label] as const),
    );

    const totals = data?.totals;
    const tokenTotals = React.useMemo(
        () =>
            (data?.buckets ?? []).reduce(
                (t, b) => ({
                    input: t.input + b.inputTokens,
                    cached: t.cached + b.cachedTokens,
                    output: t.output + b.outputTokens,
                }),
                { input: 0, cached: 0, output: 0 },
            ),
        [data?.buckets],
    );
    const ownCost =
        totals ? Math.max(0, totals.costUsd - totals.creditCostUsd) : 0;
    const empty = data?.available && (totals?.requests ?? 0) === 0;

    return (
        <main
            className={`${styles.root} mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 p-4 py-6 sm:p-6`}>
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-normal">
                        Usage
                    </h1>
                </div>
                <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={period}
                    onValueChange={v => v && setPeriod(v as UsagePeriod)}
                    aria-label="Period">
                    {PERIODS.map(p => (
                        <ToggleGroupItem
                            key={p.value}
                            value={p.value}
                            className="px-3">
                            {p.label}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
            </div>

            {error ?
                <p role="alert" className="text-destructive text-sm">
                    {error.message}
                </p>
            : isLoading || !data ?
                <div className="space-y-4">
                    <Skeleton className="h-36 w-full" />
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {[0, 1, 2, 3].map(i => (
                            <Skeleton key={i} className="h-24" />
                        ))}
                    </div>
                    <Skeleton className="h-64 w-full" />
                </div>
            :   <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Card
                            label="Platform credit"
                            value={
                                data.credit ? money(data.credit.left_usd) : "—"
                            }
                            detail={
                                data.credit ?
                                    `left of ${money(data.credit.limit_usd)}`
                                :   "The gateway could not be asked right now."
                            }>
                            {data.credit ?
                                <OneBar
                                    label="Platform credit used and left"
                                    parts={[
                                        {
                                            label: "Used",
                                            value: data.credit.used_usd,
                                            display: money(
                                                data.credit.used_usd,
                                            ),
                                            color:
                                                data.credit.left_usd <= 0 ?
                                                    "var(--critical)"
                                                : data.credit.left_usd < 1 ?
                                                    "var(--warning)"
                                                :   "var(--blue-2)",
                                        },
                                        {
                                            label: "Left",
                                            value: data.credit.left_usd,
                                            display: money(
                                                data.credit.left_usd,
                                            ),
                                            color: "var(--track)",
                                        },
                                    ]}
                                />
                            :   null}
                        </Card>
                        <Card
                            label="Spend"
                            value={money(totals?.costUsd ?? 0)}
                            detail={`${money(totals?.creditCostUsd ?? 0)} credit · ${money(ownCost)} your keys`}
                            bleed={
                                data.buckets.length > 1 ?
                                    <Sparkline
                                        label={`Spend over ${long}`}
                                        format={preciseMoney}
                                        points={data.buckets.map(b => ({
                                            at: b.at,
                                            value: Object.values(b.cost).reduce(
                                                (sum, v) => sum + v,
                                                0,
                                            ),
                                            when: new Date(b.at).toLocaleString(
                                                undefined,
                                                data.bucketSeconds < 86400 ?
                                                    {
                                                        hour: "numeric",
                                                        day: "numeric",
                                                        month: "short",
                                                    }
                                                :   {
                                                        day: "numeric",
                                                        month: "short",
                                                    },
                                            ),
                                        }))}
                                    />
                                :   null
                            }
                        />
                        <Card
                            label="Model calls"
                            value={compact(totals?.requests ?? 0)}
                            detail={`${compact((totals?.requests ?? 0) - (totals?.failed ?? 0))} succeeded · ${compact(totals?.failed ?? 0)} failed`}>
                            {data.uptime.length ?
                                <Uptime
                                    buckets={data.uptime}
                                    bucketSeconds={data.uptimeSeconds}
                                />
                            :   null}
                        </Card>
                        <Card
                            label="Tokens"
                            value={compact(
                                tokenTotals.input +
                                    tokenTotals.cached +
                                    tokenTotals.output,
                            )}>
                            <OneBar
                                label="Tokens split into input, cached and output"
                                parts={[
                                    {
                                        label: "Input",
                                        value: tokenTotals.input,
                                        display: compact(tokenTotals.input),
                                        color: "var(--blue-1)",
                                    },
                                    {
                                        label: "Cached",
                                        value: tokenTotals.cached,
                                        display: compact(tokenTotals.cached),
                                        color: "var(--blue-2)",
                                    },
                                    {
                                        label: "Output",
                                        value: tokenTotals.output,
                                        display: compact(tokenTotals.output),
                                        color: "var(--blue-3)",
                                    },
                                ]}
                            />
                        </Card>
                    </div>

                    {!data.available ?
                        <p
                            className={`${styles.ink2} bg-card rounded-lg border p-4 text-sm`}>
                            Usage could not be read from the model gateway right
                            now. Try again in a moment.
                        </p>
                    : empty ?
                        <p
                            className={`${styles.ink2} bg-card rounded-lg border p-4 text-sm`}>
                            No model calls in {long}. Usage appears here once a
                            Monitor finds a difference and the Agent looks at
                            it.
                        </p>
                    :   <>
                            <Section
                                title="Cost"
                                hint={`Per ${data.bucketSeconds < 86400 ? "hour" : "day"}, ${long}.`}
                                action={
                                    <Select
                                        value={costBy}
                                        onValueChange={v =>
                                            setCostBy(v as typeof costBy)
                                        }>
                                        <SelectTrigger
                                            size="sm"
                                            className="w-36"
                                            aria-label="Break the cost down">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent align="end">
                                            <SelectItem value="provider">
                                                By provider
                                            </SelectItem>
                                            <SelectItem value="model">
                                                By model
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                }>
                                <Legend series={costSeries} />
                                <ColumnChart
                                    label={`Cost by ${costBy} over ${long}`}
                                    columns={costColumns}
                                    series={costSeries}
                                    bucketSeconds={data.bucketSeconds}
                                    format={axisMoney}
                                    formatValue={preciseMoney}
                                />
                            </Section>

                            <div className="grid min-w-0 gap-5 lg:grid-cols-2">
                                <Section title="Model calls">
                                    <Legend series={requestSeries} />
                                    <ColumnChart
                                        label={`Model calls over ${long}`}
                                        columns={data.buckets.map(b => ({
                                            at: b.at,
                                            values: {
                                                ok: b.requests - b.failed,
                                                failed: b.failed,
                                            },
                                        }))}
                                        series={requestSeries}
                                        bucketSeconds={data.bucketSeconds}
                                        format={compact}
                                    />
                                </Section>
                                <Section title="Tokens">
                                    <Legend series={tokenSeries} />
                                    <ColumnChart
                                        label={`Tokens over ${long}`}
                                        columns={data.buckets.map(b => ({
                                            at: b.at,
                                            values: {
                                                in: b.inputTokens,
                                                cached: b.cachedTokens,
                                                out: b.outputTokens,
                                            },
                                        }))}
                                        series={tokenSeries}
                                        bucketSeconds={data.bucketSeconds}
                                        format={compact}
                                    />
                                </Section>
                            </div>

                            <Section
                                title="By model"
                                hint={`Totals for ${long}.`}>
                                <ModelsTable
                                    models={data.models}
                                    providerLabel={providerLabel}
                                />
                            </Section>
                        </>
                    }
                </>
            }
        </main>
    );
}

/** Total tokens, with the breakdown on hover or keyboard focus. */
function TokensCell({ tokens }: { tokens: Usage["models"][number]["tokens"] }) {
    const rows: [string, number][] = [
        ["Input", tokens.input],
        ["Output", tokens.output],
        ["Cache read", tokens.cacheRead],
        ["Cache write", tokens.cacheWrite],
    ];
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="focus-visible:ring-ring/50 cursor-default rounded-sm underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-[3px]">
                    {tokens.total.toLocaleString()}
                </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="px-2 py-1 text-xs">
                <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
                    {rows.map(([label, value]) => (
                        <React.Fragment key={label}>
                            <dt className="text-muted-foreground">{label}</dt>
                            <dd className={`${styles.num} text-right`}>
                                {value.toLocaleString()}
                            </dd>
                        </React.Fragment>
                    ))}
                </dl>
            </TooltipContent>
        </Tooltip>
    );
}

type SortKey = "model" | "provider" | "requests" | "failed" | "tokens" | "cost";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: "model", label: "Model", numeric: false },
    { key: "provider", label: "Provider", numeric: false },
    { key: "requests", label: "Calls", numeric: true },
    { key: "failed", label: "Failed", numeric: true },
    { key: "tokens", label: "Tokens", numeric: true },
    { key: "cost", label: "Spend", numeric: true },
];

/**
 * Totals per model, sortable by any column: a header click sorts by it
 * (numbers largest first, names A to Z), a second click reverses it.
 */
function ModelsTable({
    models,
    providerLabel,
}: {
    models: Usage["models"];
    providerLabel: Map<string, string>;
}) {
    const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
        key: "cost",
        desc: true,
    });
    const providerOf = (m: Usage["models"][number]) =>
        providerLabel.get(m.provider) ?? (m.provider || "Your keys");
    const value = (m: Usage["models"][number]): number | string => {
        switch (sort.key) {
            case "model":
                return m.model;
            case "provider":
                return providerOf(m);
            case "requests":
                return m.requests;
            case "failed":
                return m.failed;
            case "tokens":
                return m.tokens.total;
            case "cost":
                return m.costUsd;
        }
    };
    const rows = [...models].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        const order =
            typeof x === "number" && typeof y === "number" ?
                x - y
            :   String(x).localeCompare(String(y), undefined, {
                    numeric: true,
                });
        return sort.desc ? -order : order;
    });

    return (
        <div className="overflow-x-auto">
            <Table>
                <TableHeader>
                    <TableRow>
                        {COLUMNS.map(c => {
                            const active = sort.key === c.key;
                            const Icon =
                                !active ? ArrowUpDown
                                : sort.desc ? ArrowDown
                                : ArrowUp;
                            return (
                                <TableHead
                                    key={c.key}
                                    className={
                                        c.numeric ? "text-right" : undefined
                                    }
                                    aria-sort={
                                        active ?
                                            sort.desc ?
                                                "descending"
                                            :   "ascending"
                                        :   "none"
                                    }>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSort(
                                                active ?
                                                    {
                                                        key: c.key,
                                                        desc: !sort.desc,
                                                    }
                                                :   {
                                                        key: c.key,
                                                        desc: c.numeric,
                                                    },
                                            )
                                        }
                                        className={`hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-[3px] ${c.numeric ? "flex-row-reverse" : ""} ${active ? "text-foreground" : ""}`}>
                                        {c.label}
                                        <Icon
                                            className={`size-3.5 ${active ? "" : "opacity-40"}`}
                                        />
                                    </button>
                                </TableHead>
                            );
                        })}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map(m => (
                        <TableRow key={m.key}>
                            <TableCell className="font-mono text-xs">
                                {m.model}
                            </TableCell>
                            <TableCell>{providerOf(m)}</TableCell>
                            <TableCell className={`${styles.num} text-right`}>
                                {m.requests.toLocaleString()}
                            </TableCell>
                            <TableCell className={`${styles.num} text-right`}>
                                {m.failed.toLocaleString()}
                            </TableCell>
                            <TableCell className={`${styles.num} text-right`}>
                                <TokensCell tokens={m.tokens} />
                            </TableCell>
                            <TableCell className={`${styles.num} text-right`}>
                                {preciseMoney(m.costUsd)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
