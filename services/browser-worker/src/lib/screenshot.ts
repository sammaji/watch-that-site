import type { Rect, ScreenshotFormat } from "@watchthatsite/types";
import type { Logger } from "pino";
import type { Page } from "playwright-core";
import { PNG } from "pngjs";
import {
    maxScreenshotBytes,
    navigationTimeoutMs,
} from "../config/constants.js";
import { sleep } from "./stabilize.js";

/** Pause between the two frames of the two-frame check. */
export const frameGapMs = 300;
/** Extra frame pairs taken when the first two differ. */
export const frameRetries = 3;
/** Cell size of the grid diff that turns unstable pixels into masks. */
export const gridCell = 16;
/** Share of one colour above which a screenshot counts as blank. */
export const blankShare = 0.98;
const webpQuality = 80;

/** Page-coordinate area to shoot. */
export type Clip = { x: number; y: number; width: number; height: number };

export type Frame = {
    png: Buffer;
    w: number;
    h: number;
};

export type StableShot = {
    /** The last frame taken, as PNG. */
    frame: Frame;
    stable: boolean;
    /** Grid cells that still differed between the last two frames. */
    unstable: Rect[];
};

/**
 * One PNG frame of `clip`. `fullPage` lets the clip reach below the viewport;
 * `animations: "disabled"` and `caret: "hide"` remove the two sources of
 * pixel noise Playwright can control; `scale: "css"` keeps pixels equal to
 * CSS pixels whatever the scale factor.
 */
async function shoot(page: Page, clip: Clip): Promise<Frame> {
    const png = await page.screenshot({
        type: "png",
        fullPage: true,
        clip,
        animations: "disabled",
        caret: "hide",
        scale: "css",
        timeout: navigationTimeoutMs,
    });
    const { width, height } = readPngSize(png);
    return { png, w: width, h: height };
}

/**
 * Two-frame check. Takes two frames `frameGapMs` apart; when they
 * differ (bytes first, then decoded pixels), takes another frame and compares
 * it with the previous one, up to `frameRetries` times. A page that never
 * settles is `stable: false`, and the 16 px grid cells that still differ are
 * returned so the scheduler masks them instead of reporting them as a Change.
 */
export async function captureStable(
    page: Page,
    clip: Clip,
    gapMs = frameGapMs,
    retries = frameRetries,
): Promise<StableShot> {
    let previous = await shoot(page, clip);
    for (let attempt = 0; attempt <= retries; attempt++) {
        await sleep(gapMs);
        const current = await shoot(page, clip);
        if (sameFrame(previous, current)) {
            return { frame: current, stable: true, unstable: [] };
        }
        if (attempt === retries) {
            return {
                frame: current,
                stable: false,
                unstable: gridDiff(previous.png, current.png, gridCell),
            };
        }
        previous = current;
    }
    throw new Error("unreachable");
}

function sameFrame(a: Frame, b: Frame): boolean {
    if (a.png.equals(b.png)) return true;
    if (a.w !== b.w || a.h !== b.h) return false;
    const pa = PNG.sync.read(a.png).data;
    const pb = PNG.sync.read(b.png).data;
    return pa.equals(pb);
}

/**
 * Compares two PNGs on a coarse grid and returns the differing cells merged
 * into rectangles: runs of adjacent cells in a row become one rect, and
 * identical runs in consecutive rows are stacked. Frames of different sizes
 * are compared over their common area, plus the extra area as one rect.
 */
export function gridDiff(aPng: Buffer, bPng: Buffer, cell: number): Rect[] {
    const a = PNG.sync.read(aPng);
    const b = PNG.sync.read(bPng);
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);

    const cellDiffers = (cx: number, cy: number): boolean => {
        const x1 = Math.min((cx + 1) * cell, w);
        const y1 = Math.min((cy + 1) * cell, h);
        for (let y = cy * cell; y < y1; y++) {
            for (let x = cx * cell; x < x1; x++) {
                const ia = (y * a.width + x) * 4;
                const ib = (y * b.width + x) * 4;
                if (
                    a.data[ia] !== b.data[ib] ||
                    a.data[ia + 1] !== b.data[ib + 1] ||
                    a.data[ia + 2] !== b.data[ib + 2] ||
                    a.data[ia + 3] !== b.data[ib + 3]
                ) {
                    return true;
                }
            }
        }
        return false;
    };

    const rects: Rect[] = [];
    // Open rects from the previous row, keyed by "x0:x1" of their run.
    let open = new Map<string, Rect>();
    for (let cy = 0; cy < rows; cy++) {
        const next = new Map<string, Rect>();
        let runStart = -1;
        for (let cx = 0; cx <= cols; cx++) {
            const differs = cx < cols && cellDiffers(cx, cy);
            if (differs && runStart < 0) runStart = cx;
            if (!differs && runStart >= 0) {
                const x0 = runStart * cell;
                const x1 = Math.min(cx * cell, w);
                const y0 = cy * cell;
                const y1 = Math.min((cy + 1) * cell, h);
                const key = `${x0}:${x1}`;
                const above = open.get(key);
                if (above) {
                    above[3] = y1 - above[1];
                    next.set(key, above);
                    open.delete(key);
                } else {
                    const r: Rect = [x0, y0, x1 - x0, y1 - y0];
                    rects.push(r);
                    next.set(key, r);
                }
                runStart = -1;
            }
        }
        open = next;
    }

    if (a.height !== b.height) {
        rects.push([
            0,
            h,
            Math.max(a.width, b.width),
            Math.abs(a.height - b.height),
        ]);
    }
    if (a.width !== b.width) {
        rects.push([w, 0, Math.abs(a.width - b.width), h]);
    }
    return rects;
}

export type ColourStats = {
    /** Pixels of the most common colour. */
    dominant: number;
    total: number;
};

/**
 * Counts the most common colour. Boyer–Moore majority vote finds the only
 * colour that could cover more than half the image, in one pass and constant
 * memory, then a second pass counts it.
 */
export function colourStats(png: Buffer): ColourStats {
    const { data, width, height } = PNG.sync.read(png);
    const total = width * height;
    if (total === 0) return { dominant: 0, total: 0 };
    // Copy when the buffer is not 4-byte aligned, as Uint32Array requires.
    const bytes = data.byteOffset % 4 === 0 ? data : new Uint8Array(data);
    const px = new Uint32Array(bytes.buffer, bytes.byteOffset, total);
    let candidate = 0;
    let votes = 0;
    for (let i = 0; i < total; i++) {
        const c = px[i]!;
        if (votes === 0) {
            candidate = c;
            votes = 1;
        } else if (c === candidate) {
            votes++;
        } else {
            votes--;
        }
    }
    let dominant = 0;
    for (let i = 0; i < total; i++) if (px[i] === candidate) dominant++;
    return { dominant, total };
}

/** Whether one colour covers more than `share` of the image. */
export function isBlank(png: Buffer, share = blankShare): boolean {
    const { dominant, total } = colourStats(png);
    return total === 0 || dominant / total > share;
}

/**
 * The blank-screenshot check as the capture applies it. One colour over 98 %
 * is also what a legitimately sparse page looks like (a short line of text
 * on white paints well under 2 % of a 1366 px wide shot), so the Capture is
 * only called blank when, in addition, the painted pixels are far too few for
 * the text the blocks say is there: under 2 % of the block area inside the
 * shot. That catches a page hidden by an anti-flicker `opacity: 0` or a
 * renderer that painted nothing, without flagging minimal pages.
 */
export function isBlankCapture(
    png: Buffer,
    blockAreaInShot: number,
    share = blankShare,
): boolean {
    const { dominant, total } = colourStats(png);
    if (total === 0) return true;
    if (dominant / total <= share) return false;
    if (blockAreaInShot <= 0) return true;
    return (total - dominant) / blockAreaInShot < 0.02;
}

/** Width and height from a PNG's IHDR chunk. */
export function readPngSize(png: Buffer): { width: number; height: number } {
    if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) {
        throw new Error("Screenshot is not a PNG");
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

type SharpFactory = (input: Buffer) => {
    webp(opts: { quality: number }): { toBuffer(): Promise<Buffer> };
};
let sharpLoader: Promise<SharpFactory | null> | null = null;

async function loadSharp(logger: Logger): Promise<SharpFactory | null> {
    sharpLoader ??= import("sharp")
        .then(mod => mod.default as unknown as SharpFactory)
        .catch((err: unknown) => {
            logger.warn(
                { err },
                "[screenshot] sharp is unavailable; WebP screenshots fall back to PNG",
            );
            return null;
        });
    return sharpLoader;
}

export type EncodedShot = {
    bytes: Buffer;
    format: ScreenshotFormat;
};

/**
 * Encodes the PNG frame in the requested format. Playwright only produces
 * PNG and JPEG, so WebP (quality 80) goes through sharp; without sharp the
 * frame stays PNG and the Capture says so in `screenshot.format`.
 */
export async function encodeShot(
    frame: Frame,
    format: ScreenshotFormat,
    logger: Logger,
): Promise<EncodedShot> {
    let out: EncodedShot = { bytes: frame.png, format: "png" };
    if (format === "webp") {
        const sharp = await loadSharp(logger);
        if (sharp) {
            try {
                out = {
                    bytes: await sharp(frame.png)
                        .webp({ quality: webpQuality })
                        .toBuffer(),
                    format: "webp",
                };
            } catch (err) {
                logger.warn(
                    { err },
                    "[screenshot] WebP encoding failed; keeping PNG",
                );
            }
        }
    }
    if (out.bytes.byteLength === 0) {
        throw new Error("Screenshot capture produced no data");
    }
    if (out.bytes.byteLength > maxScreenshotBytes) {
        throw new Error(
            `Screenshot is ${out.bytes.byteLength} bytes, over the ${maxScreenshotBytes} byte limit`,
        );
    }
    return out;
}
