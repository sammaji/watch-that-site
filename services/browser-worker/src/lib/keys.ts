import type { ScreenshotFormat } from "@watchthatsite/types";

/**
 * Object-store keys this worker writes. The object-store Worker validates
 * these shapes on its side (packages/cloudflare/src/shared/keys.ts). Step
 * screenshots use `stepScreenshotKey` from `@watchthatsite/types`.
 */

/** The Run's screenshot: `captures/{monitor}/{run}/shot.{webp|png}`. */
export function screenshotKey(
    monitorId: string,
    runId: string,
    format: ScreenshotFormat,
): string {
    return `captures/${monitorId}/${runId}/shot.${format}`;
}

/** The Monitor's persisted storage state: `state/{monitor}.json`. */
export function storageStateKey(monitorId: string): string {
    return `state/${monitorId}.json`;
}

export function contentTypeFor(format: ScreenshotFormat): string {
    return format === "webp" ? "image/webp" : "image/png";
}
