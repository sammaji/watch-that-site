/**
 * Stored Captures for agent tests: screenshots drawn with sharp and
 * blocks.json.gz objects, put in a MemoryStore under real object keys.
 */
import type { CaptureBlock, Rect, RunRef } from "@watchthatsite/types";
import { gzipSync } from "node:zlib";
import sharp from "sharp";
import type { MemoryStore } from "./harness.js";

export type Paint = { rect: Rect; color: string };

/** A white PNG of the given size with coloured rectangles painted on it. */
export async function drawPng(
    w: number,
    h: number,
    paints: Paint[],
): Promise<Buffer> {
    return sharp({
        create: { width: w, height: h, channels: 3, background: "#ffffff" },
    })
        .composite(
            await Promise.all(
                paints.map(async p => ({
                    input: await sharp({
                        create: {
                            width: p.rect[2],
                            height: p.rect[3],
                            channels: 3,
                            background: p.color,
                        },
                    })
                        .png()
                        .toBuffer(),
                    left: p.rect[0],
                    top: p.rect[1],
                })),
            ),
        )
        .png()
        .toBuffer();
}

export function block(
    index: number,
    path: string,
    text: string,
    rect: Rect,
): CaptureBlock {
    return {
        id: `b${index}`,
        path,
        tag: path
            .split("/")
            .at(-1)!
            .replace(/\[\d+\]$/, ""),
        text,
        rect,
    };
}

/** Stores a Capture's screenshot and blocks, and returns the reference to it. */
export async function storeCapture(
    store: MemoryStore,
    monitorId: string,
    runId: string,
    blocks: CaptureBlock[],
    screenshot: Buffer | null,
): Promise<RunRef> {
    const blocksKey = `captures/${monitorId}/${runId}/blocks.json.gz`;
    await store.putObject(
        blocksKey,
        gzipSync(JSON.stringify({ version: 1, blocks, truncated: false })),
        { contentType: "application/gzip" },
    );
    let screenshotKey = "";
    if (screenshot) {
        screenshotKey = `captures/${monitorId}/${runId}/shot.png`;
        await store.putObject(screenshotKey, screenshot, {
            contentType: "image/png",
        });
    }
    return {
        run_id: runId,
        at: "2026-11-21T10:00:00Z",
        screenshot: screenshotKey,
        blocks: blocksKey,
    };
}
