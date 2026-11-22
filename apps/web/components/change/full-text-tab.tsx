"use client";

import { Segmented } from "@/components/monitor/segmented";
import { useStoredBlocks } from "@/hooks/use-change";
import {
    countedOps,
    type CaptureBlock,
    type ChangeRecord,
    type Rect,
    type TextOp,
} from "@watchthatsite/types";
import { Label } from "@watchthatsite/ui/components/label";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import { Switch } from "@watchthatsite/ui/components/switch";
import { cn } from "@watchthatsite/ui/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";
import { ScreenshotMinimap } from "./object-image";
import { OpBody, OpKindBadge } from "./word-ops";

/**
 * The "Full text" tab: the block-level text diff of the two Captures, as one
 * document or in two columns, optionally cut down to the changes. Hovering a
 * change shows where it is on the page.
 */

type Layout = "inline" | "columns";

const LAYOUTS = [
    { value: "inline", label: "One column", testId: "text-layout-inline" },
    { value: "columns", label: "Two columns", testId: "text-layout-columns" },
] as const;

type SetHovered = (rect: Rect | null) => void;

function opRect(op: TextOp): Rect | null {
    return op.rect ?? op.from_rect ?? null;
}

function hoverProps(op: TextOp, setHovered: SetHovered) {
    const rect = opRect(op);
    return {
        onMouseEnter: () => setHovered(rect),
        onMouseLeave: () => setHovered(null),
        onFocus: () => setHovered(rect),
    };
}

function ContextLines({ lines }: { lines: string[] }) {
    return (
        <div className="text-muted-foreground my-1 space-y-0.5 border-l-2 pl-2 text-xs leading-5">
            {lines.map((line, i) => (
                <p key={i} className="line-clamp-2 break-words">
                    {line}
                </p>
            ))}
        </div>
    );
}

/** One text op with up to two blocks of context on each side. */
function OpCard({
    op,
    setHovered,
    showContext = true,
}: {
    op: TextOp;
    setHovered: SetHovered;
    showContext?: boolean;
}) {
    return (
        <li
            {...hoverProps(op, setHovered)}
            data-testid="text-op"
            data-op={op.op}
            className="hover:border-ring/60 min-w-0 rounded-md border p-3 transition-colors">
            {showContext && op.context_before?.length ?
                <ContextLines lines={op.context_before} />
            :   null}
            <div className="flex min-w-0 items-start gap-2">
                <OpKindBadge op={op} />
                <p className="min-w-0 flex-1 text-sm leading-6 break-words whitespace-pre-wrap">
                    <OpBody op={op} />
                </p>
            </div>
            {op.op === "move" ?
                <p className="text-muted-foreground mt-1 text-xs">
                    Moved from position {op.from + 1} to {op.to + 1}; the words
                    are the same.
                </p>
            :   null}
            {showContext && op.context_after?.length ?
                <ContextLines lines={op.context_after} />
            :   null}
        </li>
    );
}

/** Differences in parts of the page the Watch Plan ignores, folded away. */
function IgnoredGroup({
    ops,
    count,
    setHovered,
}: {
    ops: TextOp[];
    count: number;
    setHovered: SetHovered;
}) {
    const [open, setOpen] = React.useState(false);
    const total = Math.max(count, ops.length);
    if (!total) return null;
    return (
        <div
            className="rounded-md border border-dashed"
            data-testid="ignored-blocks">
            <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
                aria-expanded={open}
                disabled={!ops.length}
                onClick={() => setOpen(o => !o)}>
                {ops.length ?
                    open ?
                        <ChevronDown className="size-3.5" />
                    :   <ChevronRight className="size-3.5" />
                :   null}
                {total} {total === 1 ? "difference" : "differences"} in parts of
                the page that are ignored (not sent to the model)
            </button>
            {open ?
                <ul className="space-y-2 px-3 pb-3">
                    {ops.map((op, i) => (
                        <OpCard
                            key={i}
                            op={op}
                            setHovered={setHovered}
                            showContext={false}
                        />
                    ))}
                </ul>
            :   null}
        </div>
    );
}

function ChangesOnly({
    record,
    setHovered,
}: {
    record: ChangeRecord;
    setHovered: SetHovered;
}) {
    const text = record.text!;
    const counted = countedOps(text);
    const ignored = text.ops.filter(op => op.op === "ignored");
    return (
        <div className="space-y-3">
            {counted.length ?
                <ul className="space-y-2">
                    {counted.map((op, i) => (
                        <OpCard key={i} op={op} setHovered={setHovered} />
                    ))}
                </ul>
            :   <p className="text-muted-foreground text-sm">
                    No words changed in the parts of the page being watched.
                </p>
            }
            <IgnoredGroup
                ops={ignored}
                count={text.ignored_count}
                setHovered={setHovered}
            />
        </div>
    );
}

/** A block of a full document, with its op overlaid when it has one. */
function DocBlock({
    block,
    op,
    side,
    setHovered,
}: {
    block?: CaptureBlock;
    op?: TextOp;
    side: "both" | "before" | "after";
    setHovered: SetHovered;
}) {
    if (!op) {
        return <p className="py-0.5 break-words">{block?.text}</p>;
    }
    const tone =
        op.op === "ignored" ? "opacity-60"
        : op.op === "move" ? "border-l-2 border-sky-500 pl-2"
        : "border-l-2 border-amber-500 pl-2";
    const body =
        op.op === "move" || op.op === "ignored" ?
            <span
                className={op.op === "ignored" ? "text-muted-foreground" : ""}>
                {op.op === "move" ?
                    <span
                        aria-hidden
                        className="text-sky-600 dark:text-sky-400">
                        ↪{" "}
                    </span>
                :   null}
                {block?.text ?? op.text}
            </span>
        :   <OpBody op={op} side={side} />;
    return (
        <div
            data-testid="doc-change"
            className={cn("min-w-0 py-0.5", tone)}
            {...hoverProps(op, setHovered)}>
            <p className="min-w-0 break-words whitespace-pre-wrap">
                {body}
                {op.op === "move" ?
                    <span className="text-muted-foreground ml-1 text-xs">
                        moved
                    </span>
                : op.op === "ignored" ?
                    <span className="text-muted-foreground ml-1 text-xs">
                        (in an ignored part of the page)
                    </span>
                :   null}
            </p>
        </div>
    );
}

function BlocksState({
    isLoading,
    error,
}: {
    isLoading: boolean;
    error: string | null;
}) {
    if (isLoading) {
        return (
            <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-5/6" />
            </div>
        );
    }
    return (
        <p className="text-muted-foreground text-sm">
            {error ?? "The captured text is no longer stored."}
        </p>
    );
}

function Inline({
    record,
    setHovered,
}: {
    record: ChangeRecord;
    setHovered: SetHovered;
}) {
    const to = useStoredBlocks(record.to.blocks);
    const from = useStoredBlocks(record.from.blocks);
    const ops = React.useMemo(() => record.text?.ops ?? [], [record.text]);

    const rows = React.useMemo(() => {
        if (!to.blocks) return null;
        const byBlock = new Map<string, TextOp>();
        for (const op of ops) {
            if (op.block_id && op.op !== "remove") byBlock.set(op.block_id, op);
        }
        // Removed blocks have no "after" position: place each one after the
        // nearest preceding "before" block that still exists (by path).
        const toIndexByPath = new Map<string, number>();
        to.blocks.blocks.forEach((b, i) => {
            if (!toIndexByPath.has(b.path)) toIndexByPath.set(b.path, i);
        });
        const insertAfter = new Map<number, TextOp[]>();
        const fromBlocks = from.blocks?.blocks ?? [];
        for (const op of ops) {
            if (op.op !== "remove") continue;
            let anchor = -1;
            const fromIndex = fromBlocks.findIndex(
                b => b.id === op.from_block_id,
            );
            for (let j = fromIndex - 1; j >= 0; j--) {
                const idx = toIndexByPath.get(fromBlocks[j]!.path);
                if (idx !== undefined) {
                    anchor = idx;
                    break;
                }
            }
            if (fromIndex < 0)
                anchor = Math.min(op.to, to.blocks.blocks.length) - 1;
            insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), op]);
        }
        const out: Array<{ key: string; block?: CaptureBlock; op?: TextOp }> =
            [];
        (insertAfter.get(-1) ?? []).forEach((op, k) =>
            out.push({ key: `rm-start-${k}`, op }),
        );
        to.blocks.blocks.forEach((block, i) => {
            out.push({ key: block.id, block, op: byBlock.get(block.id) });
            (insertAfter.get(i) ?? []).forEach((op, k) =>
                out.push({ key: `rm-${i}-${k}`, op }),
            );
        });
        return out;
    }, [to.blocks, from.blocks, ops]);

    if (!rows) return <BlocksState isLoading={to.isLoading} error={to.error} />;
    return (
        <div
            data-testid="text-inline"
            className="max-h-[75vh] space-y-0.5 overflow-y-auto rounded-md border p-3 text-sm leading-6">
            {to.blocks?.truncated ?
                <p className="text-muted-foreground mb-2 text-xs">
                    The page was too long to store whole; its end is not shown.
                </p>
            :   null}
            {rows.map(row => (
                <DocBlock
                    key={row.key}
                    block={row.block}
                    op={row.op}
                    side="both"
                    setHovered={setHovered}
                />
            ))}
        </div>
    );
}

function Columns({
    record,
    changesOnly,
    setHovered,
}: {
    record: ChangeRecord;
    changesOnly: boolean;
    setHovered: SetHovered;
}) {
    const to = useStoredBlocks(record.to.blocks);
    const from = useStoredBlocks(record.from.blocks);
    const ops = React.useMemo(() => record.text?.ops ?? [], [record.text]);
    const { afterOps, beforeOps } = React.useMemo(() => {
        const afterOps = new Map<string, TextOp>();
        const beforeOps = new Map<string, TextOp>();
        for (const op of ops) {
            if (op.block_id && op.op !== "remove")
                afterOps.set(op.block_id, op);
            if (op.from_block_id && op.op !== "add")
                beforeOps.set(op.from_block_id, op);
        }
        return { afterOps, beforeOps };
    }, [ops]);

    return (
        <div
            data-testid="text-columns"
            className="grid min-w-0 gap-3 md:grid-cols-2">
            {(
                [
                    ["Before", from, beforeOps, "before"],
                    ["After", to, afterOps, "after"],
                ] as const
            ).map(([title, state, map, side]) => {
                const blocks =
                    changesOnly ?
                        state.blocks?.blocks.filter(block => map.has(block.id))
                    :   state.blocks?.blocks;
                return (
                    <section key={title} className="min-w-0 rounded-md border">
                        <h3 className="bg-muted/50 border-b px-3 py-1.5 text-xs font-medium">
                            {title}
                        </h3>
                        <div className="max-h-[70vh] space-y-0.5 overflow-y-auto p-3 text-sm leading-6">
                            {blocks ?
                                blocks.length ?
                                    blocks.map(block => (
                                        <DocBlock
                                            key={block.id}
                                            block={block}
                                            op={map.get(block.id)}
                                            side={side}
                                            setHovered={setHovered}
                                        />
                                    ))
                                :   <p className="text-muted-foreground text-sm">
                                        Nothing changed on this side.
                                    </p>

                            :   <BlocksState
                                    isLoading={state.isLoading}
                                    error={state.error}
                                />
                            }
                        </div>
                    </section>
                );
            })}
        </div>
    );
}

export function FullTextTab({ record }: { record: ChangeRecord }) {
    const [layout, setLayout] = React.useState<Layout>("inline");
    const [changesOnly, setChangesOnly] = React.useState(false);
    const [hovered, setHovered] = React.useState<Rect | null>(null);
    const rects = React.useMemo(
        () =>
            countedOps(record.text)
                .map(op => op.rect)
                .filter((r): r is Rect => !!r),
        [record.text],
    );

    if (!record.text) {
        return (
            <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                The text of these Captures was not compared.
            </p>
        );
    }

    const showMinimap = !!record.to.screenshot && layout === "inline";
    return (
        <div className="space-y-3" data-testid="full-text">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Segmented
                    label="How to lay out the text"
                    value={layout}
                    onChange={setLayout}
                    options={LAYOUTS}
                />
                <div className="flex items-center gap-2">
                    <Switch
                        id="changes-only"
                        data-testid="changes-only"
                        checked={changesOnly}
                        onCheckedChange={setChangesOnly}
                    />
                    <Label
                        htmlFor="changes-only"
                        className="text-muted-foreground font-normal">
                        Changes only
                    </Label>
                </div>
            </div>
            <div
                className={cn(
                    "grid min-w-0 gap-4",
                    showMinimap && "lg:grid-cols-[minmax(0,1fr)_200px]",
                )}>
                <div className="min-w-0">
                    {layout === "columns" ?
                        <Columns
                            record={record}
                            changesOnly={changesOnly}
                            setHovered={setHovered}
                        />
                    : changesOnly ?
                        <ChangesOnly record={record} setHovered={setHovered} />
                    :   <Inline record={record} setHovered={setHovered} />}
                </div>
                {showMinimap ?
                    <aside className="hidden lg:block">
                        <div className="sticky top-2 space-y-1">
                            <p className="text-muted-foreground text-xs">
                                Hover a change to find it on the page
                            </p>
                            <ScreenshotMinimap
                                screenshotKey={record.to.screenshot}
                                rects={rects}
                                hovered={hovered}
                                size={record.visual?.size_after ?? null}
                            />
                        </div>
                    </aside>
                :   null}
            </div>
        </div>
    );
}
