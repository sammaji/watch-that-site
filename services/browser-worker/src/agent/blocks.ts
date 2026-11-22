import {
    pathUnder,
    type CaptureBlock,
    type Rect,
    type StoredBlocks,
    type WatchSection,
} from "@watchthatsite/types";
import { gunzipSync } from "node:zlib";
import type { ObjectStore } from "../types.js";
import { union } from "./images.js";

/**
 * A Capture's stored blocks (`captures/{monitor}/{run}/blocks.json.gz`), read
 * through the object store. Null when the key is empty or the object is gone.
 */
export async function loadBlocks(
    store: ObjectStore | null,
    key: string,
): Promise<CaptureBlock[] | null> {
    if (!store || !key) return null;
    const bytes = await store.getObject(key);
    if (!bytes) return null;
    const buffer = Buffer.from(bytes);
    // The scheduler stores gzip; tolerate a plain JSON object as well.
    const json =
        buffer[0] === 0x1f && buffer[1] === 0x8b ?
            gunzipSync(buffer).toString("utf8")
        :   buffer.toString("utf8");
    const parsed = JSON.parse(json) as StoredBlocks | CaptureBlock[];
    const blocks = Array.isArray(parsed) ? parsed : parsed.blocks;
    return Array.isArray(blocks) ? blocks : [];
}

/**
 * Where a Section is on a Capture's screenshot: the rectangle around every
 * block under its paths. Null when none of its blocks is on the page.
 */
export function sectionRect(
    section: Pick<WatchSection, "paths">,
    blocks: CaptureBlock[],
): Rect | null {
    return union(
        blocks
            .filter(b => section.paths.some(root => pathUnder(b.path, root)))
            .map(b => b.rect),
    );
}
