/**
 * Thin typed wrapper over the R2 binding. Knows about objects, not about HTTP.
 */

import type { ParsedObjectKey } from "../shared/keys.js";

export interface StoredObjectSummary {
    key: string;
    size: number;
    etag: string;
    uploaded: string;
    content_type: string | null;
}

export function summarize(object: R2Object): StoredObjectSummary {
    return {
        key: object.key,
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded.toISOString(),
        content_type: object.httpMetadata?.contentType ?? null,
    };
}

export function putObject(
    bucket: R2Bucket,
    parsed: ParsedObjectKey,
    body: ReadableStream,
    contentType: string,
): Promise<R2Object> {
    return bucket.put(parsed.key, body, {
        httpMetadata: { contentType },
        customMetadata: {
            kind: parsed.kind,
            monitor_id: parsed.monitorId,
        },
    });
}

/**
 * Range and conditional headers are forwarded straight to R2, which understands
 * the `Headers` form of both options.
 */
export function getObject(
    bucket: R2Bucket,
    key: string,
    headers: Headers,
): Promise<R2ObjectBody | R2Object | null> {
    return bucket.get(key, { range: headers, onlyIf: headers });
}

export function headObject(
    bucket: R2Bucket,
    key: string,
): Promise<R2Object | null> {
    return bucket.head(key);
}

export function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
    return bucket.delete(key);
}

export function listObjects(
    bucket: R2Bucket,
    options: { prefix: string; cursor?: string; limit: number },
): Promise<R2Objects> {
    return bucket.list({
        prefix: options.prefix,
        cursor: options.cursor,
        limit: options.limit,
        // Without this, listed objects carry no contentType.
        include: ["httpMetadata"],
    });
}
