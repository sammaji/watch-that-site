"use client";

import * as React from "react";
import styles from "./usage.module.css";

export interface ChartSeries {
    key: string;
    label: string;
    /** A CSS colour, normally one of the module's `--series-*` tokens. */
    color: string;
}

export interface ChartColumn {
    /** Bucket start, ISO 8601. */
    at: string;
    values: Record<string, number>;
}

const HEIGHT = 180;
const PAD = { top: 12, right: 8, bottom: 22, left: 52 };
const GAP = 2;

/** Rounds a maximum up to a clean axis top with four even steps. */
function niceTop(max: number): number {
    if (max <= 0) return 1;
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)!;
    return step * 4;
}

function bucketLabel(at: string, bucketSeconds: number, long = false): string {
    const d = new Date(at);
    if (bucketSeconds < 86400) {
        return d.toLocaleTimeString(undefined, {
            hour: "numeric",
            ...(long ? { day: "numeric", month: "short" } : {}),
        });
    }
    return d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(long ? { weekday: "short" } : {}),
    });
}

/**
 * Stacked columns over time, one column per bucket, with a hover tooltip that
 * lists every series in the bucket. Series keep their order and colour
 * whatever the data, so a colour always means the same thing.
 */
export function ColumnChart({
    columns,
    series,
    bucketSeconds,
    format,
    formatValue = format,
    label,
}: {
    columns: ChartColumn[];
    series: ChartSeries[];
    bucketSeconds: number;
    /** Axis labels. */
    format: (value: number) => string;
    /** Values in the tooltip; defaults to `format`. */
    formatValue?: (value: number) => string;
    /** Accessible name of the chart. */
    label: string;
}) {
    const ref = React.useRef<HTMLDivElement>(null);
    const [width, setWidth] = React.useState(0);
    const [hover, setHover] = React.useState<number | null>(null);

    React.useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) =>
            setWidth(Math.floor(entry!.contentRect.width)),
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const totals = columns.map(c =>
        series.reduce((sum, s) => sum + (c.values[s.key] ?? 0), 0),
    );
    const top = niceTop(Math.max(0, ...totals));
    const plotW = Math.max(0, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const slot = columns.length ? plotW / columns.length : 0;
    const barW = Math.max(2, Math.min(28, slot * 0.62));
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
    const ticks = [0, 1, 2, 3, 4].map(i => (top / 4) * i);
    // Label every nth bucket so x labels never collide.
    const every = Math.max(
        1,
        Math.ceil(columns.length / Math.max(1, Math.floor(plotW / 64))),
    );

    const hovered = hover === null ? null : columns[hover];

    return (
        <div ref={ref} className="relative w-full min-w-0">
            {width > 0 ?
                <svg
                    width={width}
                    height={HEIGHT}
                    role="img"
                    aria-label={label}
                    onMouseLeave={() => setHover(null)}>
                    {ticks.map(t => (
                        <g key={t}>
                            <line
                                x1={PAD.left}
                                x2={width - PAD.right}
                                y1={y(t)}
                                y2={y(t)}
                                stroke="var(--grid)"
                                strokeWidth={1}
                            />
                            <text
                                x={PAD.left - 8}
                                y={y(t)}
                                dy="0.32em"
                                textAnchor="end"
                                fontSize={11}
                                fill="var(--ink-3)"
                                className={styles.num}>
                                {format(t)}
                            </text>
                        </g>
                    ))}
                    {columns.map((c, i) => {
                        const cx = PAD.left + slot * i + slot / 2;
                        let base = 0;
                        const parts = series
                            .map(s => ({ s, v: c.values[s.key] ?? 0 }))
                            .filter(p => p.v > 0);
                        return (
                            <g key={c.at}>
                                {/* The hit target is the whole slot, not the thin mark. */}
                                <rect
                                    x={PAD.left + slot * i}
                                    y={PAD.top}
                                    width={slot}
                                    height={plotH}
                                    fill={
                                        hover === i ? "var(--grid)" : (
                                            "transparent"
                                        )
                                    }
                                    onMouseEnter={() => setHover(i)}
                                />
                                {parts.map((p, j) => {
                                    const y0 = y(base);
                                    base += p.v;
                                    const y1 = y(base);
                                    const isTop = j === parts.length - 1;
                                    // A 2 px gap in the surface colour between stacked segments.
                                    const h = Math.max(
                                        1,
                                        y0 - y1 - (isTop ? 0 : GAP),
                                    );
                                    const r =
                                        isTop ?
                                            Math.min(4, h / 2, barW / 2)
                                        :   0;
                                    const x = cx - barW / 2;
                                    const yTop = y1 + (isTop ? 0 : GAP);
                                    return (
                                        <path
                                            key={p.s.key}
                                            pointerEvents="none"
                                            fill={p.s.color}
                                            d={`M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`}
                                        />
                                    );
                                })}
                                {i % every === 0 ?
                                    <text
                                        x={cx}
                                        y={HEIGHT - 6}
                                        textAnchor="middle"
                                        fontSize={11}
                                        fill="var(--ink-3)">
                                        {bucketLabel(c.at, bucketSeconds)}
                                    </text>
                                :   null}
                            </g>
                        );
                    })}
                </svg>
            :   <div style={{ height: HEIGHT }} />}
            {hovered && hover !== null ?
                <div
                    className={styles.tooltip}
                    style={{
                        top: 4,
                        ...(PAD.left + slot * hover + slot / 2 > width / 2 ?
                            { right: width - (PAD.left + slot * hover) + 8 }
                        :   { left: PAD.left + slot * (hover + 1) + 8 }),
                    }}>
                    <div className={`${styles.ink2} mb-1 font-medium`}>
                        {bucketLabel(hovered.at, bucketSeconds, true)}
                    </div>
                    {series.map(s => (
                        <div key={s.key} className="flex items-center gap-2">
                            <span
                                className={styles.swatch}
                                style={{ background: s.color }}
                            />
                            <span className="min-w-0 flex-1 truncate">
                                {s.label}
                            </span>
                            <span>
                                {formatValue(hovered.values[s.key] ?? 0)}
                            </span>
                        </div>
                    ))}
                    {series.length > 1 ?
                        <div
                            className="mt-1 flex justify-between border-t pt-1 font-medium"
                            style={{ borderColor: "var(--grid)" }}>
                            <span>Total</span>
                            <span>{formatValue(totals[hover] ?? 0)}</span>
                        </div>
                    :   null}
                </div>
            :   null}
        </div>
    );
}

/** The legend: always present for two or more series, never for one. */
export function Legend({ series }: { series: ChartSeries[] }) {
    if (series.length < 2) return null;
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {series.map(s => (
                <span
                    key={s.key}
                    className={`${styles.ink2} flex items-center gap-1.5`}>
                    <span
                        className={styles.swatch}
                        style={{ background: s.color }}
                    />
                    {s.label}
                </span>
            ))}
        </div>
    );
}
