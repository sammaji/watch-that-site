"use client";

import {
    countedOps,
    type ChangeItem,
    type ChangeRecord,
    type Rect,
    type Region,
    type TextOp,
    type WatchPlan,
} from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import { cn } from "@watchthatsite/ui/lib/utils";
import { CloudOff, Maximize2 } from "lucide-react";
import * as React from "react";
import {
    AFTER_LABEL_CLASS,
    AFTER_PANEL_CLASS,
    BEFORE_LABEL_CLASS,
    BEFORE_PANEL_CLASS,
    itemSection,
    sectionName,
} from "./lib";
import { ScreenshotCrop } from "./object-image";
import { OpBody, OpKindBadge } from "./word-ops";

/**
 * The "What changed" tab: the agent's answer as one card per Item, each with
 * what it was before and what it is now (the quoted text with word-level
 * highlights, and a crop of each screenshot), then what the agent saw and
 * left out. Without an agent answer it falls back to the text differences.
 */

export type Side = "before" | "after";

/** Asks the Side by side tab to show these places. */
export type Locate = (target: {
    before: Rect | null;
    after: Rect | null;
}) => void;

const MAX_OPS_PER_ITEM = 3;
const MAX_FALLBACK_OPS = 12;
const MAX_FALLBACK_REGIONS = 6;

function validSize(
    size: [number, number] | undefined,
): [number, number] | null {
    return size && size[0] > 0 && size[1] > 0 ? size : null;
}

/** Whether an op has anything to show on this side. */
function opHasSide(op: TextOp, side: Side): boolean {
    if (op.op === "add") return side === "after";
    if (op.op === "remove") return side === "before";
    return true;
}

function SidePanel({
    side,
    item,
    ops,
    screenshotKey,
    size,
    rect,
    onLocate,
}: {
    side: Side;
    item: ChangeItem;
    ops: TextOp[];
    screenshotKey: string;
    size: [number, number] | null;
    rect: Rect | null;
    onLocate: () => void;
}) {
    const quoted = side === "before" ? item.before : item.after;
    const shown = ops.filter(op => opHasSide(op, side));
    const empty = shown.length === 0 && quoted.trim() === "";
    return (
        <div
            data-testid={`item-${side}`}
            className={cn(
                "flex min-w-0 flex-col gap-2 rounded-md border p-3",
                side === "before" ? BEFORE_PANEL_CLASS : AFTER_PANEL_CLASS,
            )}>
            <p
                className={cn(
                    "text-xs font-semibold tracking-wide uppercase",
                    side === "before" ? BEFORE_LABEL_CLASS : AFTER_LABEL_CLASS,
                )}>
                {side === "before" ? "Before" : "After"}
            </p>
            {empty ?
                <p className="text-muted-foreground text-sm italic">
                    {side === "before" ?
                        "Not on the page before."
                    :   "No longer on the page."}
                </p>
            : shown.length ?
                <div className="space-y-1.5">
                    {shown.slice(0, MAX_OPS_PER_ITEM).map((op, i) => (
                        <blockquote
                            key={i}
                            className="text-sm leading-6 break-words whitespace-pre-wrap">
                            <OpBody op={op} side={side} />
                        </blockquote>
                    ))}
                    {shown.length > MAX_OPS_PER_ITEM ?
                        <p className="text-muted-foreground text-xs">
                            and {shown.length - MAX_OPS_PER_ITEM} more in the
                            Full text tab
                        </p>
                    :   null}
                </div>
            :   <blockquote className="text-sm leading-6 break-words whitespace-pre-wrap">
                    {quoted}
                </blockquote>
            }
            {rect && screenshotKey ?
                <button
                    type="button"
                    onClick={onLocate}
                    aria-label={`Show this place on the ${side} screenshot`}
                    className="group focus-visible:ring-ring/50 relative mt-auto block w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-[3px]">
                    <ScreenshotCrop
                        screenshotKey={screenshotKey}
                        rect={rect}
                        size={size}
                        alt={`The ${side} screenshot around “${item.title}”`}
                    />
                    <span className="bg-background/90 text-foreground absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        <Maximize2 className="size-3" /> Side by side
                    </span>
                </button>
            :   null}
        </div>
    );
}

function ItemCard({
    item,
    number,
    record,
    onLocate,
}: {
    item: ChangeItem;
    number: number;
    record: ChangeRecord;
    onLocate: Locate;
}) {
    const ops = item.ops
        .map(index => record.text?.ops[index])
        .filter((op): op is TextOp => !!op);
    const locate = () =>
        onLocate({ before: item.rect_before, after: item.rect_after });
    return (
        <li
            data-testid="change-item"
            className="bg-card min-w-0 space-y-3 rounded-lg border p-3 sm:p-4">
            <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-rose-600 text-xs font-semibold text-white tabular-nums">
                    {number}
                </span>
                <div className="min-w-0 space-y-0.5">
                    <h3 className="text-base leading-6 font-medium break-words">
                        {item.title}
                    </h3>
                    {item.matches ?
                        <p className="text-muted-foreground text-sm break-words">
                            Matches your instructions: {item.matches}
                        </p>
                    :   null}
                </div>
            </div>
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
                <SidePanel
                    side="before"
                    item={item}
                    ops={ops}
                    screenshotKey={record.from.screenshot}
                    size={validSize(record.visual?.size_before)}
                    rect={item.rect_before}
                    onLocate={locate}
                />
                <SidePanel
                    side="after"
                    item={item}
                    ops={ops}
                    screenshotKey={record.to.screenshot}
                    size={validSize(record.visual?.size_after)}
                    rect={item.rect_after}
                    onLocate={locate}
                />
            </div>
        </li>
    );
}

/** One text difference as a plain row. */
function TextDifference({ op, onLocate }: { op: TextOp; onLocate: Locate }) {
    const rect = op.rect ?? null;
    const fromRect = op.from_rect ?? null;
    return (
        <li
            data-testid="text-op"
            className="flex min-w-0 items-start gap-2 rounded-md border p-3">
            <OpKindBadge op={op} />
            <p className="min-w-0 flex-1 text-sm leading-6 break-words whitespace-pre-wrap">
                <OpBody op={op} />
            </p>
            {rect || fromRect ?
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Show this on the screenshots"
                    onClick={() =>
                        onLocate({
                            before: fromRect ?? rect,
                            after: rect ?? fromRect,
                        })
                    }>
                    <Maximize2 />
                </Button>
            :   null}
        </li>
    );
}

/** One area that looks different, as a crop of each screenshot. */
function RegionDifference({
    region,
    number,
    record,
    onLocate,
}: {
    region: Region;
    number: number;
    record: ChangeRecord;
    onLocate: Locate;
}) {
    const before = region.from_box ?? null;
    const sides = [
        ["Before", record.from.screenshot, before, record.visual?.size_before],
        ["After", record.to.screenshot, region.box, record.visual?.size_after],
    ] as const;
    return (
        <li
            data-testid="region-difference"
            className="min-w-0 space-y-2 rounded-md border p-3">
            <p className="flex items-center gap-2 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-600 text-[11px] font-semibold text-white tabular-nums">
                    {number}
                </span>
                {before ?
                    "This area looks different"
                :   "This area is new on the page"}
            </p>
            <button
                type="button"
                aria-label={`Show area ${number} on the screenshots`}
                onClick={() => onLocate({ before, after: region.box })}
                className="focus-visible:ring-ring/50 grid w-full min-w-0 cursor-zoom-in gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] sm:grid-cols-2">
                {sides.map(([label, key, rect, size]) =>
                    key && rect ?
                        <span key={label} className="block min-w-0 space-y-1">
                            <span
                                className={cn(
                                    "block text-xs font-semibold tracking-wide uppercase",
                                    label === "Before" ? BEFORE_LABEL_CLASS : (
                                        AFTER_LABEL_CLASS
                                    ),
                                )}>
                                {label}
                            </span>
                            <ScreenshotCrop
                                screenshotKey={key}
                                rect={rect}
                                size={validSize(size)}
                                alt={`${label}: area ${number}`}
                            />
                        </span>
                    :   null,
                )}
            </button>
        </li>
    );
}

/**
 * Everything that differs, for when there is no agent answer (the model
 * could not be reached, or two Captures were compared on demand): the text
 * differences, then the areas that look different.
 */
function Differences({
    record,
    onLocate,
    onOpenFullText,
}: {
    record: ChangeRecord;
    onLocate: Locate;
    onOpenFullText: () => void;
}) {
    const ops = countedOps(record.text);
    const regions = record.visual?.regions ?? [];
    if (ops.length === 0 && regions.length === 0) {
        return (
            <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                No words changed and no area of the page looks different in the
                parts being watched.
            </p>
        );
    }
    return (
        <div className="space-y-3">
            {ops.length ?
                <ul className="space-y-2" data-testid="text-differences">
                    {ops.slice(0, MAX_FALLBACK_OPS).map((op, i) => (
                        <TextDifference key={i} op={op} onLocate={onLocate} />
                    ))}
                </ul>
            :   null}
            {ops.length > MAX_FALLBACK_OPS ?
                <Button
                    variant="link"
                    className="h-auto p-0"
                    onClick={onOpenFullText}>
                    See all {ops.length} text differences in Full text
                </Button>
            :   null}
            {regions.length ?
                <ul className="space-y-2" data-testid="region-differences">
                    {regions.slice(0, MAX_FALLBACK_REGIONS).map((region, i) => (
                        <RegionDifference
                            key={i}
                            region={region}
                            number={i + 1}
                            record={record}
                            onLocate={onLocate}
                        />
                    ))}
                </ul>
            :   null}
            {regions.length > MAX_FALLBACK_REGIONS ?
                <p className="text-muted-foreground text-xs">
                    {regions.length - MAX_FALLBACK_REGIONS} more areas are
                    outlined in the Side by side tab.
                </p>
            :   null}
        </div>
    );
}

export function ItemsTab({
    record,
    plan,
    onLocate,
    onOpenFullText,
}: {
    record: ChangeRecord;
    /** The Monitor's current Watch Plan, to name Sections older records lack. */
    plan: WatchPlan | null;
    onLocate: Locate;
    onOpenFullText: () => void;
}) {
    const agent = record.agent;
    const unavailable = !!agent?.unavailable;

    // Items keep their numbers (they match the outlines on the screenshots)
    // and are grouped under the Section they sit in, in order of appearance.
    const groups = React.useMemo(() => {
        const out: { id: string; name: string; items: number[] }[] = [];
        record.items.forEach((item, index) => {
            const id = itemSection(item, record, plan);
            const name = sectionName(id, record, plan);
            const key = name ? id : "";
            let group = out.find(g => g.id === key);
            if (!group) {
                group = { id: key, name, items: [] };
                out.push(group);
            }
            group.items.push(index);
        });
        return out;
    }, [record, plan]);
    const grouped = groups.some(group => group.name !== "");

    return (
        <div className="space-y-5" data-testid="what-changed">
            {unavailable ?
                <div
                    role="status"
                    data-testid="agent-unavailable"
                    className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
                    <CloudOff className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <p className="min-w-0 break-words">
                        The model could not be reached, so this was reported
                        without a summary.
                        {agent?.error ?
                            <span className="text-muted-foreground">
                                {" "}
                                ({agent.error})
                            </span>
                        :   null}{" "}
                        Below is everything that differs.
                    </p>
                </div>
            :   null}

            {record.items.length ?
                <div className="space-y-5">
                    {groups.map(group => (
                        <section key={group.id || "none"} className="space-y-2">
                            {grouped ?
                                <h3
                                    data-testid="item-section"
                                    className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                                    {group.name || "Elsewhere on the page"}
                                </h3>
                            :   null}
                            <ol className="space-y-3">
                                {group.items.map(index => (
                                    <ItemCard
                                        key={index}
                                        item={record.items[index]!}
                                        number={index + 1}
                                        record={record}
                                        onLocate={onLocate}
                                    />
                                ))}
                            </ol>
                        </section>
                    ))}
                </div>
            :   <section className="space-y-2">
                    {unavailable ? null : (
                        <h3 className="text-sm font-medium">
                            {record.status === "noise" ?
                                "What was different"
                            :   "Everything that differs"}
                        </h3>
                    )}
                    <Differences
                        record={record}
                        onLocate={onLocate}
                        onOpenFullText={onOpenFullText}
                    />
                </section>
            }

            {record.ignored.length ?
                <section className="space-y-2" data-testid="also-different">
                    <h3 className="text-muted-foreground text-sm font-medium">
                        Also different, not reported
                    </h3>
                    <ul className="text-muted-foreground divide-y rounded-lg border border-dashed text-sm">
                        {record.ignored.map((ignored, i) => (
                            <li key={i} className="px-3 py-2 break-words">
                                <span className="text-foreground/80">
                                    {ignored.note}
                                </span>
                                {ignored.reason ?
                                    <span> · {ignored.reason}</span>
                                :   null}
                            </li>
                        ))}
                    </ul>
                </section>
            :   null}
        </div>
    );
}
