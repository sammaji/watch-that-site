"use client";

import { Segmented } from "@/components/monitor/segmented";
import { useStoredBlocks } from "@/hooks/use-change";
import type { ChangeRecord, Rect, WatchPlan } from "@watchthatsite/types";
import { Label } from "@watchthatsite/ui/components/label";
import { Slider } from "@watchthatsite/ui/components/slider";
import { Switch } from "@watchthatsite/ui/components/switch";
import { cn } from "@watchthatsite/ui/lib/utils";
import { MoveVertical } from "lucide-react";
import * as React from "react";
import { formatNumber, sectionRects } from "./lib";
import { BoxOverlay, ObjectImage, type Box } from "./object-image";

/**
 * The "Side by side" tab: the two Capture screenshots as proof, in four
 * modes (2-up, slider, onion skin, difference image). The reported places
 * are outlined and numbered to match the Items; the Watch Plan's Sections
 * can be outlined too.
 */

type VisualMode = "2up" | "slider" | "onion" | "difference";

const VISUAL_MODES = [
    { value: "2up", label: "2-up", testId: "visual-mode-2up" },
    { value: "slider", label: "Slider", testId: "visual-mode-slider" },
    { value: "onion", label: "Onion skin", testId: "visual-mode-onion" },
    {
        value: "difference",
        label: "Difference",
        testId: "visual-mode-difference",
    },
] as const;

/** A place to bring into view; `nonce` changes on every request. */
export type Focus = {
    before: Rect | null;
    after: Rect | null;
    nonce: number;
};

function validSize(
    size: [number, number] | undefined | null,
): [number, number] | null {
    return size && size[0] > 0 && size[1] > 0 ? size : null;
}

/** A scrollable frame; tall full-page screenshots scroll inside it. */
const Stage = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
    function Stage({ children, className, ...props }, ref) {
        return (
            <div
                ref={ref}
                className={cn(
                    "bg-muted/30 max-h-[70vh] min-w-0 overflow-x-hidden overflow-y-auto rounded-md border",
                    className,
                )}
                {...props}>
                {children}
            </div>
        );
    },
);

function Captioned({
    caption,
    children,
}: {
    caption: string;
    children: React.ReactNode;
}) {
    return (
        <figure className="min-w-0 space-y-1">
            <figcaption className="text-muted-foreground text-xs font-medium">
                {caption}
            </figcaption>
            {children}
        </figure>
    );
}

/** Scrolls `stage` so that `rect` (in image pixels) sits a third down. */
function scrollToRect(
    stage: HTMLDivElement | null,
    rect: Rect | null,
    imageWidth: number | undefined,
) {
    if (!stage || !rect || !imageWidth) return;
    const scale = stage.clientWidth / imageWidth;
    stage.scrollTop = Math.max(0, rect[1] * scale - stage.clientHeight / 3);
}

function SliderView({
    before,
    after,
    boxes,
    size,
    stageRef,
}: {
    before: string;
    after: string;
    boxes: Box[];
    size: [number, number] | null;
    stageRef: React.Ref<HTMLDivElement>;
}) {
    const [pos, setPos] = React.useState(50);
    const dragging = React.useRef(false);
    const update = (event: React.PointerEvent<HTMLDivElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        const next = ((event.clientX - box.left) / box.width) * 100;
        setPos(Math.max(0, Math.min(100, next)));
    };
    return (
        <div className="space-y-2">
            <Stage ref={stageRef}>
                <div
                    className="relative cursor-ew-resize touch-pan-y"
                    data-testid="visual-slider-stage"
                    onPointerDown={event => {
                        dragging.current = true;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        update(event);
                    }}
                    onPointerMove={event => {
                        if (dragging.current) update(event);
                    }}
                    onPointerUp={() => {
                        dragging.current = false;
                    }}
                    onPointerCancel={() => {
                        dragging.current = false;
                    }}>
                    <ObjectImage shared objectKey={after} alt="After" />
                    <div
                        className="absolute inset-0"
                        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
                        <ObjectImage
                            shared
                            objectKey={before}
                            alt="Before"
                            className="bg-background"
                        />
                    </div>
                    <BoxOverlay boxes={boxes} size={size} />
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 w-0.5 bg-sky-500"
                        style={{ left: `${pos}%` }}>
                        <span className="sticky top-3 left-1/2 flex size-6 -translate-x-1/2 items-center justify-center rounded-full bg-sky-500 text-[10px] text-white shadow">
                            ⇆
                        </span>
                    </div>
                </div>
            </Stage>
            <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">Before</span>
                <Slider
                    aria-label="How much of the before screenshot to show"
                    value={[pos]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={v => setPos(v[0] ?? 50)}
                />
                <span className="text-muted-foreground">After</span>
            </div>
        </div>
    );
}

function OnionView({
    before,
    after,
    boxes,
    size,
    stageRef,
}: {
    before: string;
    after: string;
    boxes: Box[];
    size: [number, number] | null;
    stageRef: React.Ref<HTMLDivElement>;
}) {
    const [opacity, setOpacity] = React.useState(50);
    return (
        <div className="space-y-2">
            <Stage ref={stageRef}>
                <div className="relative" data-testid="visual-onion-stage">
                    <ObjectImage shared objectKey={before} alt="Before" />
                    <div
                        className="absolute inset-0"
                        style={{ opacity: opacity / 100 }}>
                        <ObjectImage shared objectKey={after} alt="After" />
                    </div>
                    <BoxOverlay boxes={boxes} size={size} />
                </div>
            </Stage>
            <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">Before</span>
                <Slider
                    aria-label="How strongly the after screenshot shows through"
                    value={[opacity]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={v => setOpacity(v[0] ?? 50)}
                />
                <span className="text-muted-foreground">After</span>
            </div>
        </div>
    );
}

export function SideBySideTab({
    record,
    plan,
    focus,
}: {
    record: ChangeRecord;
    /** The Monitor's Watch Plan, for "Outline Sections". */
    plan: WatchPlan | null;
    focus: Focus | null;
}) {
    const visual = record.visual;
    const [mode, setMode] = React.useState<VisualMode>("2up");
    const [outlineSections, setOutlineSections] = React.useState(false);
    const before = record.from.screenshot;
    const after = record.to.screenshot;
    const [loadedBefore, setLoadedBefore] = React.useState<
        [number, number] | null
    >(null);
    const [loadedAfter, setLoadedAfter] = React.useState<
        [number, number] | null
    >(null);
    const sizeAfter = validSize(visual?.size_after) ?? loadedAfter;
    const sizeBefore = validSize(visual?.size_before) ?? loadedBefore;

    const canOutline = !!plan && plan.sections.length > 0;
    const toBlocks = useStoredBlocks(
        canOutline && outlineSections ? record.to.blocks : null,
    );
    const fromBlocks = useStoredBlocks(
        canOutline && outlineSections ? record.from.blocks : null,
    );

    const { boxesBefore, boxesAfter } = React.useMemo(() => {
        const beforeOut: Box[] = [];
        const afterOut: Box[] = [];
        if (outlineSections && plan) {
            const sides = [
                [sectionRects(plan, fromBlocks.blocks?.blocks), beforeOut],
                [sectionRects(plan, toBlocks.blocks?.blocks), afterOut],
            ] as const;
            for (const [rects, out] of sides) {
                for (const section of plan.sections) {
                    const rect = rects.get(section.id);
                    if (!rect) continue;
                    out.push({
                        rect,
                        key: `s-${section.id}`,
                        label: section.name,
                        tone: section.how === "ignore" ? "ignored" : "section",
                    });
                }
            }
        }
        if (record.items.length) {
            // Numbered like the Items in "What changed".
            record.items.forEach((item, i) => {
                if (item.rect_before) {
                    beforeOut.push({
                        rect: item.rect_before,
                        key: `i${i}`,
                        label: String(i + 1),
                    });
                }
                if (item.rect_after) {
                    afterOut.push({
                        rect: item.rect_after,
                        key: `i${i}`,
                        label: String(i + 1),
                    });
                }
            });
        } else {
            // No agent answer: outline every area that looks different.
            (visual?.regions ?? []).forEach((region, i) => {
                afterOut.push({
                    rect: region.box,
                    key: `g${i}`,
                    label: String(i + 1),
                });
                // The same area on the before screenshot, when it had one.
                if (region.from_box) {
                    beforeOut.push({
                        rect: region.from_box,
                        key: `g${i}`,
                        label: String(i + 1),
                    });
                }
            });
        }
        if (visual?.shift && sizeAfter) {
            afterOut.push({
                rect: [
                    0,
                    visual.shift.from_y + visual.shift.dy,
                    sizeAfter[0],
                    0,
                ],
                key: "shift",
                tone: "shift",
            });
        }
        if (focus?.before) {
            beforeOut.push({ rect: focus.before, key: "focus", tone: "focus" });
        }
        if (focus?.after) {
            afterOut.push({ rect: focus.after, key: "focus", tone: "focus" });
        }
        return { boxesBefore: beforeOut, boxesAfter: afterOut };
    }, [
        outlineSections,
        plan,
        fromBlocks.blocks,
        toBlocks.blocks,
        record.items,
        visual,
        sizeAfter,
        focus,
    ]);

    const beforeStage = React.useRef<HTMLDivElement>(null);
    const afterStage = React.useRef<HTMLDivElement>(null);
    const lastTop = React.useRef({ before: 0, after: 0 });

    // In 2-up the two screenshots scroll together. They move by the same
    // distance rather than to the same offset, so they stay lined up on a
    // place that sits at different heights before and after.
    const syncScroll = (event: React.UIEvent<HTMLDivElement>) => {
        const side =
            event.currentTarget.dataset.side === "before" ? "before" : "after";
        const top = event.currentTarget.scrollTop;
        const delta = top - lastTop.current[side];
        lastTop.current[side] = top;
        if (delta === 0) return;
        const otherSide = side === "before" ? "after" : "before";
        const other =
            otherSide === "before" ? beforeStage.current : afterStage.current;
        if (!other) return;
        other.scrollTop += delta;
        lastTop.current[otherSide] = other.scrollTop;
    };

    // Bring the requested place into view, each side at its own position.
    React.useEffect(() => {
        if (!focus) return;
        if (mode === "2up") {
            scrollToRect(
                beforeStage.current,
                focus.before ?? focus.after,
                sizeBefore?.[0],
            );
            scrollToRect(
                afterStage.current,
                focus.after ?? focus.before,
                sizeAfter?.[0],
            );
        } else {
            scrollToRect(
                afterStage.current,
                focus.after ?? focus.before,
                sizeAfter?.[0],
            );
        }
        lastTop.current = {
            before: beforeStage.current?.scrollTop ?? 0,
            after: afterStage.current?.scrollTop ?? 0,
        };
        // Sizes are read once the images have loaded; rerun then.
    }, [focus, mode, sizeBefore, sizeAfter]);

    if (!after && !before) {
        return (
            <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                No screenshots are stored for these Captures.
            </p>
        );
    }

    return (
        <div className="space-y-3" data-testid="side-by-side">
            {visual?.shift ?
                <div
                    data-testid="shift-banner"
                    className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    <MoveVertical className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <span>
                        Everything below{" "}
                        {formatNumber(Math.round(visual.shift.from_y))} px moved{" "}
                        {visual.shift.dy >= 0 ? "down" : "up"} by{" "}
                        {formatNumber(Math.abs(Math.round(visual.shift.dy)))}{" "}
                        px. Moving on its own is not counted as a difference.
                    </span>
                </div>
            :   null}

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Segmented
                    label="How to compare the screenshots"
                    value={mode}
                    onChange={setMode}
                    options={VISUAL_MODES}
                />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    {canOutline ?
                        <div className="flex items-center gap-2">
                            <Switch
                                id="outline-sections"
                                data-testid="outline-sections"
                                checked={outlineSections}
                                onCheckedChange={setOutlineSections}
                            />
                            <Label
                                htmlFor="outline-sections"
                                className="text-muted-foreground font-normal">
                                Outline Sections
                            </Label>
                        </div>
                    :   null}
                </div>
            </div>

            {mode === "2up" || !before || !after ?
                <div
                    className="grid min-w-0 gap-3 md:grid-cols-2"
                    data-testid="visual-2up">
                    {before ?
                        <Captioned caption="Before">
                            <Stage
                                ref={beforeStage}
                                data-side="before"
                                onScroll={syncScroll}>
                                <div className="relative">
                                    <ObjectImage
                                        shared
                                        objectKey={before}
                                        alt="Before"
                                        onSize={setLoadedBefore}
                                    />
                                    <BoxOverlay
                                        boxes={boxesBefore}
                                        size={sizeBefore}
                                    />
                                </div>
                            </Stage>
                        </Captioned>
                    :   null}
                    {after ?
                        <Captioned caption="After">
                            <Stage
                                ref={afterStage}
                                data-side="after"
                                onScroll={syncScroll}>
                                <div className="relative">
                                    <ObjectImage
                                        shared
                                        objectKey={after}
                                        alt="After"
                                        onSize={setLoadedAfter}
                                    />
                                    <BoxOverlay
                                        boxes={boxesAfter}
                                        size={sizeAfter}
                                    />
                                </div>
                            </Stage>
                        </Captioned>
                    :   null}
                </div>
            : mode === "slider" ?
                <SliderView
                    before={before}
                    after={after}
                    boxes={boxesAfter}
                    size={sizeAfter}
                    stageRef={afterStage}
                />
            : mode === "onion" ?
                <OnionView
                    before={before}
                    after={after}
                    boxes={boxesAfter}
                    size={sizeAfter}
                    stageRef={afterStage}
                />
            :   <Stage ref={afterStage} data-testid="visual-difference">
                    <div className="relative">
                        {visual?.diff_image ?
                            <ObjectImage
                                shared
                                objectKey={visual.diff_image}
                                alt="Difference image"
                            />
                        :   <ObjectImage
                                shared
                                objectKey={after}
                                alt="After"
                                className="opacity-40"
                            />
                        }
                        <BoxOverlay boxes={boxesAfter} size={sizeAfter} />
                    </div>
                </Stage>
            }

            {mode === "difference" && !visual?.diff_image ?
                <p className="text-muted-foreground text-xs">
                    No difference image was stored for this Change; the outlines
                    show where it differs.
                </p>
            :   null}

            {sizeBefore && sizeAfter && sizeBefore[1] !== sizeAfter[1] ?
                <p className="text-muted-foreground text-xs">
                    The page went from {formatNumber(sizeBefore[1])} to{" "}
                    {formatNumber(sizeAfter[1])} px tall.
                </p>
            :   null}
        </div>
    );
}
