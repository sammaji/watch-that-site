"use client";

import { objectUrl } from "@/hooks/use-change";
import type { Rect } from "@watchthatsite/types";
import { cn } from "@watchthatsite/ui/lib/utils";
import * as React from "react";

/**
 * Private objects are read through `/api/v1/objects/{key}`. For a plain
 * `<img>` that is a 302 to a short-lived signed URL, which the browser cannot
 * cache: the same screenshot shown twice is downloaded twice. A Change view
 * shows each Capture screenshot many times (one crop per Item and side, plus
 * the Side by side tab), so those are fetched once into a blob URL and shared.
 */
type Shared = {
    promise: Promise<string>;
    url: string | null;
    users: number;
    release: number | null;
};

const shared = new Map<string, Shared>();

/** How long an unused blob stays around, so switching tabs does not refetch. */
const KEEP_MS = 60_000;

function acquire(key: string): Shared {
    let entry = shared.get(key);
    if (!entry) {
        const created: Shared = {
            promise: fetch(`${objectUrl(key)}?inline=1`, { cache: "no-store" })
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`object ${response.status}`);
                    }
                    return response.blob();
                })
                .then(blob => {
                    created.url = URL.createObjectURL(blob);
                    return created.url;
                }),
            url: null,
            users: 0,
            release: null,
        };
        created.promise.catch(() => shared.delete(key));
        shared.set(key, created);
        entry = created;
    }
    if (entry.release !== null) {
        window.clearTimeout(entry.release);
        entry.release = null;
    }
    entry.users++;
    return entry;
}

function release(key: string, entry: Shared) {
    entry.users--;
    if (entry.users > 0) return;
    entry.release = window.setTimeout(() => {
        if (shared.get(key) === entry) shared.delete(key);
        if (entry.url) URL.revokeObjectURL(entry.url);
    }, KEEP_MS);
}

/** A blob URL for the object, shared by every component showing it. */
export function useSharedObject(key: string | null | undefined): {
    url: string | null;
    failed: boolean;
} {
    const [state, setState] = React.useState<{
        key: string;
        url: string | null;
        failed: boolean;
    } | null>(null);

    React.useEffect(() => {
        if (!key) return;
        let alive = true;
        const entry = acquire(key);
        entry.promise.then(
            url => alive && setState({ key, url, failed: false }),
            () => alive && setState({ key, url: null, failed: true }),
        );
        return () => {
            alive = false;
            release(key, entry);
        };
    }, [key]);

    if (!key || state?.key !== key) {
        return { url: shared.get(key ?? "")?.url ?? null, failed: false };
    }
    return { url: state.url, failed: state.failed };
}

function Unavailable({
    alt,
    text,
    className,
}: {
    alt: string;
    text?: string;
    className?: string;
}) {
    return (
        <div
            role="img"
            aria-label={`${alt} is no longer stored.`}
            className={cn(
                "bg-muted text-muted-foreground flex min-h-24 items-center justify-center rounded-md p-4 text-center text-xs",
                className,
            )}>
            {text ?? `${alt} is no longer stored.`}
        </div>
    );
}

/**
 * A private object as an image. `shared` fetches it once for every place it
 * is shown (use it for Capture screenshots); without it the image loads
 * lazily through the signed redirect (use it for one-off thumbnails).
 */
export function ObjectImage({
    objectKey,
    alt,
    className,
    style,
    onSize,
    shared: useShared = false,
    unavailableText,
}: {
    objectKey: string;
    alt: string;
    className?: string;
    style?: React.CSSProperties;
    onSize?: (size: [number, number]) => void;
    shared?: boolean;
    /** Shown in place of the image when it is gone; defaults to the alt text. */
    unavailableText?: string;
}) {
    const blob = useSharedObject(useShared ? objectKey : null);
    const [failed, setFailed] = React.useState(false);
    if (failed || blob.failed) {
        return (
            <Unavailable
                alt={alt}
                text={unavailableText}
                className={className}
            />
        );
    }
    const src = useShared ? blob.url : objectUrl(objectKey);
    if (!src) {
        return (
            <div
                aria-busy="true"
                className={cn(
                    "bg-muted min-h-24 w-full animate-pulse rounded-md",
                    className,
                )}
            />
        );
    }
    return (
        // eslint-disable-next-line @next/next/no-img-element -- a signed or blob URL; Next's optimizer cannot cache it
        <img
            src={src}
            alt={alt}
            draggable={false}
            loading={useShared ? undefined : "lazy"}
            className={cn("block h-auto w-full select-none", className)}
            style={style}
            onError={() => setFailed(true)}
            onLoad={event =>
                onSize?.([
                    event.currentTarget.naturalWidth,
                    event.currentTarget.naturalHeight,
                ])
            }
        />
    );
}

export type Box = {
    rect: Rect;
    label?: string;
    tone?: "change" | "active" | "focus" | "section" | "ignored" | "shift";
    key: string;
};

const TONE: Record<NonNullable<Box["tone"]>, string> = {
    change: "border-2 border-rose-500/80 bg-rose-500/10",
    // Hovered: everything else is dimmed while the pointer is on it.
    active: "border-2 border-sky-500 bg-sky-500/20 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)] z-10",
    // Asked for from an Item: stays marked without dimming the proof.
    focus: "border-2 border-sky-500 bg-sky-500/10 ring-4 ring-sky-500/25 z-10",
    section: "border border-dashed border-indigo-500/80 bg-indigo-500/5",
    ignored: "border border-dashed border-zinc-500/80 bg-zinc-500/15",
    shift: "border-t-2 border-dashed border-amber-500",
};

const LABEL_TONE: Record<NonNullable<Box["tone"]>, string> = {
    change: "bg-rose-600 text-white",
    active: "bg-sky-600 text-white",
    focus: "bg-sky-600 text-white",
    section: "bg-indigo-600 text-white",
    ignored: "bg-zinc-600 text-white",
    shift: "bg-amber-600 text-white",
};

/** Boxes positioned in screenshot pixels over an image of size `size`. */
export function BoxOverlay({
    boxes,
    size,
}: {
    boxes: Box[];
    size: [number, number] | null;
}) {
    if (!size || !size[0] || !size[1]) return null;
    const [w, h] = size;
    return (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
            {boxes.map(box => {
                const tone = box.tone ?? "change";
                return (
                    <div
                        key={box.key}
                        className={cn("absolute rounded-[2px]", TONE[tone])}
                        style={{
                            left: `${(box.rect[0] / w) * 100}%`,
                            top: `${(box.rect[1] / h) * 100}%`,
                            width: `${(Math.max(box.rect[2], 2) / w) * 100}%`,
                            height: `${(Math.max(box.rect[3], 2) / h) * 100}%`,
                        }}>
                        {box.label ?
                            <span
                                className={cn(
                                    // Above the box, or inside it when the box touches
                                    // the top edge and there is no room above.
                                    box.rect[1] < 18 ?
                                        "top-0 rounded-br"
                                    :   "bottom-full rounded-t",
                                    "absolute -left-0.5 max-w-[12rem] truncate px-1 text-[10px] leading-4 font-semibold whitespace-nowrap",
                                    LABEL_TONE[tone],
                                )}>
                                {box.label}
                            </span>
                        :   null}
                    </div>
                );
            })}
        </div>
    );
}

/** Space kept around a rect so the crop shows where on the page it sits. */
const CROP_PAD = 40;
const CROP_MIN_W = 360;
const CROP_MIN_H = 96;
/** A crop is never drawn taller than this many times its width. */
const CROP_MAX_TALL = 1.1;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The area to show for `rect` on an image of `size`: the rect padded, grown
 * to a readable minimum, kept within the image, and cut short when very tall.
 */
export function cropArea(rect: Rect, size: [number, number]): Rect {
    const [iw, ih] = size;
    let w = Math.min(iw, Math.max(rect[2] + CROP_PAD * 2, CROP_MIN_W));
    let h = Math.min(ih, Math.max(rect[3] + CROP_PAD * 2, CROP_MIN_H));
    if (h > w * CROP_MAX_TALL) h = Math.round(w * CROP_MAX_TALL);
    // A very wide, short strip would render a few pixels high: give it height.
    if (h < w / 6) h = Math.min(ih, Math.round(w / 6));
    w = Math.round(w);
    const x = clamp(Math.round(rect[0] + rect[2] / 2 - w / 2), 0, iw - w);
    // Tall rects are shown from their top, where the change starts.
    const y =
        rect[3] + CROP_PAD * 2 > h ?
            clamp(Math.round(rect[1] - CROP_PAD), 0, ih - h)
        :   clamp(Math.round(rect[1] + rect[3] / 2 - h / 2), 0, ih - h);
    return [x, y, w, h];
}

/**
 * Shows the part of a Capture screenshot around `rect`, with the rect
 * outlined. The crop is drawn from the full screenshot with CSS (the image is
 * scaled and offset inside a clipped box), so no extra image is stored.
 */
export function ScreenshotCrop({
    screenshotKey,
    rect,
    size: knownSize,
    alt,
    tone = "change",
    className,
}: {
    screenshotKey: string;
    rect: Rect;
    /** The screenshot's size when the record has it; else read on load. */
    size?: [number, number] | null;
    alt: string;
    tone?: Box["tone"];
    className?: string;
}) {
    const { url, failed } = useSharedObject(screenshotKey);
    const [loaded, setLoaded] = React.useState<[number, number] | null>(null);
    const size =
        knownSize && knownSize[0] > 0 && knownSize[1] > 0 ? knownSize : loaded;

    if (failed) return <Unavailable alt={alt} className={className} />;

    const area = size ? cropArea(rect, size) : null;
    // The border sits on an outer box. Everything inside is placed in
    // percentages of the inner box, whose shape is exactly the crop's: with
    // the border on the same box, its two pixels would change that shape and
    // the outline would drift off the thing it outlines.
    return (
        <div
            className={cn(
                "bg-muted w-full overflow-hidden rounded-md border",
                !area && "min-h-24 animate-pulse",
                className,
            )}>
            <div
                className="relative w-full overflow-hidden"
                style={
                    area ?
                        { aspectRatio: `${area[2]} / ${area[3]}` }
                    :   undefined
                }>
                {url ?
                    // eslint-disable-next-line @next/next/no-img-element -- a blob URL
                    <img
                        src={url}
                        alt={alt}
                        draggable={false}
                        className={cn(
                            "absolute max-w-none select-none",
                            !area && "invisible",
                        )}
                        style={
                            area && size ?
                                {
                                    width: `${(size[0] / area[2]) * 100}%`,
                                    left: `${(-area[0] / area[2]) * 100}%`,
                                    top: `${(-area[1] / area[3]) * 100}%`,
                                }
                            :   undefined
                        }
                        onLoad={event =>
                            setLoaded([
                                event.currentTarget.naturalWidth,
                                event.currentTarget.naturalHeight,
                            ])
                        }
                    />
                :   null}
                {area ?
                    <div
                        aria-hidden
                        className={cn(
                            "pointer-events-none absolute rounded-[2px]",
                            TONE[tone ?? "change"],
                            "bg-transparent",
                        )}
                        // Drawn a little outside the rect, so the outline
                        // frames small text rather than sitting on it.
                        style={{
                            left: `calc(${((rect[0] - area[0]) / area[2]) * 100}% - 4px)`,
                            top: `calc(${((rect[1] - area[1]) / area[3]) * 100}% - 4px)`,
                            width: `calc(${(rect[2] / area[2]) * 100}% + 8px)`,
                            height: `calc(${(rect[3] / area[3]) * 100}% + 8px)`,
                        }}
                    />
                :   null}
            </div>
        </div>
    );
}

/**
 * A scaled copy of the "after" screenshot with every changed block faintly
 * outlined and the hovered one highlighted, next to the Full text tab.
 */
export function ScreenshotMinimap({
    screenshotKey,
    rects,
    hovered,
    size: knownSize,
}: {
    screenshotKey: string;
    rects: Rect[];
    hovered: Rect | null;
    size: [number, number] | null;
}) {
    const [loaded, setLoaded] = React.useState<[number, number] | null>(null);
    const size = loaded ?? knownSize;
    const containerRef = React.useRef<HTMLDivElement>(null);

    // Keep the hovered box in view inside the scrollable mini-map.
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el || !hovered || !size) return;
        const scale = el.clientWidth / size[0];
        const target = hovered[1] * scale - el.clientHeight / 3;
        el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }, [hovered, size]);

    const boxes: Box[] = rects.map((rect, i) => ({
        rect,
        key: `r${i}`,
        tone: "change",
    }));
    if (hovered) boxes.push({ rect: hovered, key: "hovered", tone: "active" });

    return (
        <div
            ref={containerRef}
            data-testid="screenshot-minimap"
            className="bg-muted/40 max-h-[70vh] overflow-x-hidden overflow-y-auto rounded-md border">
            <div className="relative">
                <ObjectImage
                    shared
                    objectKey={screenshotKey}
                    alt="Screenshot after the change"
                    onSize={setLoaded}
                />
                <BoxOverlay boxes={boxes} size={size} />
            </div>
        </div>
    );
}
