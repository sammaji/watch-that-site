import type { Rect } from "@watchthatsite/types";
import sharp from "sharp";
import { maxModelImageSide } from "../config/constants.js";
import type { ObjectStore } from "../types.js";
import type { ImagePart } from "./types.js";

/**
 * Images for the model: crops and downscaled views of stored screenshots.
 *
 * Small images go out as PNG, so text and thin lines stay exact; large ones
 * as JPEG, which every provider reads and which keeps requests small.
 */

const losslessMaxPixels = 600_000;

export type ModelImage = {
    part: ImagePart;
    /** The part of the source this shows, in source pixels. */
    box: Rect;
    /** Model-image pixels per source pixel; 1 when not downscaled. */
    scale: number;
    w: number;
    h: number;
};

/** A stored screenshot, decoded lazily and once per job. */
export class StoredImage {
    private constructor(
        readonly bytes: Buffer,
        readonly w: number,
        readonly h: number,
    ) {}

    /** Null when the key is empty or the object is gone (retention). */
    static async load(
        store: ObjectStore | null,
        key: string,
    ): Promise<StoredImage | null> {
        if (!store || !key) return null;
        const bytes = await store.getObject(key);
        if (!bytes) return null;
        const buffer = Buffer.from(bytes);
        const meta = await sharp(buffer).metadata();
        if (!meta.width || !meta.height) return null;
        return new StoredImage(buffer, meta.width, meta.height);
    }

    static async fromBuffer(buffer: Buffer): Promise<StoredImage> {
        const meta = await sharp(buffer).metadata();
        return new StoredImage(buffer, meta.width ?? 0, meta.height ?? 0);
    }

    /** `box` grown by `pad` on every side and clamped to the image; null when nothing is left. */
    clamp(box: Rect, pad = 0): Rect | null {
        const x0 = Math.max(0, Math.floor(box[0] - pad));
        const y0 = Math.max(0, Math.floor(box[1] - pad));
        const x1 = Math.min(this.w, Math.ceil(box[0] + box[2] + pad));
        const y1 = Math.min(this.h, Math.ceil(box[1] + box[3] + pad));
        if (x1 - x0 < 1 || y1 - y0 < 1) return null;
        return [x0, y0, x1 - x0, y1 - y0];
    }

    /**
     * The part of the image inside `box` (padded), at full resolution when
     * it fits within `maxSide`, downscaled otherwise.
     */
    async crop(
        box: Rect,
        opts: { pad?: number; maxSide?: number } = {},
    ): Promise<ModelImage | null> {
        const area = this.clamp(box, opts.pad ?? 0);
        if (!area) return null;
        const maxSide = opts.maxSide ?? maxModelImageSide;
        const [x, y, w, h] = area;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        let pipeline = sharp(this.bytes).extract({
            left: x,
            top: y,
            width: w,
            height: h,
        });
        const outW = Math.max(1, Math.round(w * scale));
        const outH = Math.max(1, Math.round(h * scale));
        if (scale < 1) pipeline = pipeline.resize(outW, outH, { fit: "fill" });
        const lossless = outW * outH <= losslessMaxPixels;
        const data =
            lossless ?
                await pipeline.png().toBuffer()
            :   await pipeline
                    .flatten({ background: "#ffffff" })
                    .jpeg({ quality: 85 })
                    .toBuffer();
        return {
            part: {
                type: "image",
                mediaType: lossless ? "image/png" : "image/jpeg",
                data,
            },
            box: area,
            scale,
            w: outW,
            h: outH,
        };
    }

    /** The whole image, downscaled to fit `maxSide`. */
    whole(maxSide = maxModelImageSide): Promise<ModelImage | null> {
        return this.crop([0, 0, this.w, this.h], { maxSide });
    }

    /**
     * The whole image as a few tiles top to bottom, each readable on its
     * own: the width is brought down to `maxWidth`, and the height is cut
     * every `maxSide` pixels. A very tall page is scaled down further so it
     * fits in `maxTiles`.
     */
    async tiles(
        opts: { maxWidth?: number; maxTiles?: number } = {},
    ): Promise<ModelImage[]> {
        const maxWidth = opts.maxWidth ?? 1024;
        const maxTiles = opts.maxTiles ?? 5;
        let scale = Math.min(1, maxWidth / this.w);
        if (this.h * scale > maxTiles * maxModelImageSide) {
            scale = (maxTiles * maxModelImageSide) / this.h;
        }
        const count = Math.max(
            1,
            Math.ceil((this.h * scale) / maxModelImageSide),
        );
        const tileH = Math.ceil(this.h / count);
        const out: ModelImage[] = [];
        for (let i = 0; i < count; i++) {
            const y = i * tileH;
            const h = Math.min(tileH, this.h - y);
            if (h < 1) break;
            const tile = await this.crop([0, y, this.w, h], {
                maxSide: Math.max(
                    Math.round(this.w * scale),
                    Math.round(h * scale),
                ),
            });
            if (tile) out.push(tile);
        }
        return out;
    }
}

/** "x=10 y=20 w=300 h=40", the way boxes are written for the model. */
export function boxText(box: Rect): string {
    return `x=${box[0]} y=${box[1]} w=${box[2]} h=${box[3]}`;
}

/** The smallest rectangle around `rects`, or null when there are none. */
export function union(rects: Rect[]): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y, w, h] of rects) {
        if (w <= 0 || h <= 0) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + w);
        y1 = Math.max(y1, y + h);
    }
    return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : null;
}
