import type { Logger } from "pino";
import type { Locator, Page } from "playwright-core";
import sharp from "sharp";
import type { ObjectStore } from "../types.js";

/** WebP quality of step screenshots: they illustrate a trace, nothing reads them closely. */
const stepQuality = 60;

/**
 * A screenshot of what is on screen now, as PNG. `sensitive` elements (fields
 * a secret was typed into) are covered, so a secret typed into a plain text
 * field never appears in a stored image or in one sent to a model.
 */
export async function viewportPng(
    page: Page,
    sensitive: Locator[] = [],
): Promise<Buffer> {
    return page.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css",
        timeout: 15_000,
        ...(sensitive.length > 0 ?
            { mask: sensitive, maskColor: "#888888" }
        :   {}),
    });
}

/**
 * Uploads a viewport screenshot to `key` as WebP and returns the key, or null
 * when it could not be taken or stored. Step screenshots are best effort.
 */
export async function uploadStepScreenshot(
    page: Page,
    objectStore: ObjectStore | null,
    key: string,
    sensitive: Locator[],
    logger: Logger,
    png?: Buffer,
): Promise<string | null> {
    if (objectStore === null) return null;
    try {
        const shot = png ?? (await viewportPng(page, sensitive));
        const webp = await sharp(shot)
            .webp({ quality: stepQuality })
            .toBuffer();
        await objectStore.putObject(key, webp, { contentType: "image/webp" });
        return key;
    } catch (err) {
        logger.debug({ err, key }, "[steps] could not store a step screenshot");
        return null;
    }
}
