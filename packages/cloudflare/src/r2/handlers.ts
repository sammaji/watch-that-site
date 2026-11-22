/**
 * HTTP handlers for `/objects`. Each one validates the request, calls the
 * store, and maps the result onto a response.
 */

import { authorizeRead } from "../auth.js";
import { MAX_OBJECT_BYTES, jsonError } from "../http.js";
import {
    ALLOWED_CONTENT_TYPES,
    KEY_FORMAT_HINT,
    isAllowedListPrefix,
    parseObjectKey,
} from "../shared/keys.js";
import {
    deleteObject,
    getObject,
    headObject,
    listObjects,
    putObject,
    summarize,
} from "./store.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

function invalidKey(rawKey: string): Response {
    return jsonError(
        400,
        "invalid_key",
        `Invalid object key "${rawKey}": ${KEY_FORMAT_HINT}.`,
    );
}

export async function handlePut(
    request: Request,
    env: Env,
    rawKey: string,
): Promise<Response> {
    const parsed = parseObjectKey(rawKey);
    if (parsed === null) {
        return invalidKey(rawKey);
    }

    const contentType = (request.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        return jsonError(
            415,
            "unsupported_media_type",
            `Content-Type must be one of: ${[...ALLOWED_CONTENT_TYPES].join(", ")}.`,
        );
    }
    if (contentType !== parsed.contentType) {
        return jsonError(
            415,
            "unsupported_media_type",
            `Key "${parsed.key}" must be stored as ${parsed.contentType}, got ${contentType}.`,
        );
    }

    // R2 needs a known length to stream a body in, and the cap has to be
    // enforced before the bytes are read rather than after.
    const rawLength = request.headers.get("content-length");
    if (rawLength === null) {
        return jsonError(
            411,
            "length_required",
            "Content-Length is required to stream an upload into R2.",
        );
    }
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        return jsonError(
            400,
            "invalid_content_length",
            "Content-Length must be a non-negative integer.",
        );
    }
    if (contentLength === 0) {
        return jsonError(
            400,
            "empty_body",
            "Refusing to store an empty object.",
        );
    }
    if (contentLength > MAX_OBJECT_BYTES) {
        return jsonError(
            413,
            "payload_too_large",
            `Object exceeds the ${MAX_OBJECT_BYTES} byte limit.`,
        );
    }
    if (request.body === null) {
        return jsonError(400, "empty_body", "A request body is required.");
    }

    const object = await putObject(
        env.WATCHTHATSITE_BUCKET,
        parsed,
        request.body,
        contentType,
    );
    console.log(
        JSON.stringify({
            message: "object stored",
            key: parsed.key,
            size: object.size,
            monitor_id: parsed.monitorId,
        }),
    );

    // Objects are private: there is no public link to return. See StoredObject.url.
    return Response.json(
        { ...summarize(object), url: "" },
        {
            status: 201,
            headers: {
                ETag: object.httpEtag,
                Location: `/objects/${parsed.key}`,
            },
        },
    );
}

interface ResolvedRange {
    length: number;
    contentRange: string;
}

/**
 * Turns the range R2 actually served back into a `Content-Range` header.
 *
 * `R2Object.range` carries all three keys with undefined values, so the shape
 * has to be discriminated on the values rather than with `in`. R2 also
 * populates it for an unconditional read, so a partial response is only
 * correct when the caller actually sent a `Range` header.
 */
function resolveRange(
    object: R2Object,
    rangeRequested: boolean,
): ResolvedRange | null {
    const range = object.range as
        { offset?: number; length?: number; suffix?: number } | undefined;
    if (!rangeRequested || range === undefined) {
        return null;
    }

    const total = object.size;
    let offset: number;
    let length: number;
    if (typeof range.suffix === "number") {
        length = Math.min(range.suffix, total);
        offset = total - length;
    } else {
        offset = range.offset ?? 0;
        length = range.length ?? total - offset;
    }
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) {
        return null;
    }

    return {
        length,
        contentRange: `bytes ${offset}-${offset + length - 1}/${total}`,
    };
}

function metadataHeaders(object: R2Object, cacheControl: string): Headers {
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    // Always ours, never whatever was stored with the object: reads are
    // private, and a signed read may only be cached until it expires.
    headers.set("Cache-Control", cacheControl);
    return headers;
}

export async function handleGet(
    request: Request,
    env: Env,
    rawKey: string,
): Promise<Response> {
    const parsed = parseObjectKey(rawKey);
    if (parsed === null) {
        return invalidKey(rawKey);
    }
    const grant = await authorizeRead(request, env, parsed.key);
    if (!grant.ok) {
        return grant.response;
    }

    const object = await getObject(
        env.WATCHTHATSITE_BUCKET,
        parsed.key,
        request.headers,
    );
    if (object === null) {
        return jsonError(
            404,
            "not_found",
            `No object stored at "${parsed.key}".`,
        );
    }

    const headers = metadataHeaders(object, grant.cacheControl);

    // A precondition failed: R2 hands back metadata with no body.
    if (!("body" in object) || object.body === null) {
        const notModified =
            request.headers.has("if-none-match") ||
            request.headers.has("if-modified-since");
        return new Response(null, { status: notModified ? 304 : 412, headers });
    }

    const range = resolveRange(object, request.headers.has("range"));
    if (range !== null) {
        headers.set("Content-Range", range.contentRange);
        headers.set("Content-Length", String(range.length));
        return new Response(object.body, { status: 206, headers });
    }

    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
}

export async function handleHead(
    request: Request,
    env: Env,
    rawKey: string,
): Promise<Response> {
    const parsed = parseObjectKey(rawKey);
    if (parsed === null) {
        return invalidKey(rawKey);
    }
    const grant = await authorizeRead(request, env, parsed.key);
    if (!grant.ok) {
        return grant.response;
    }

    const object = await headObject(env.WATCHTHATSITE_BUCKET, parsed.key);
    if (object === null) {
        return jsonError(
            404,
            "not_found",
            `No object stored at "${parsed.key}".`,
        );
    }

    const headers = metadataHeaders(object, grant.cacheControl);
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
}

export async function handleDelete(
    _request: Request,
    env: Env,
    rawKey: string,
): Promise<Response> {
    const parsed = parseObjectKey(rawKey);
    if (parsed === null) {
        return invalidKey(rawKey);
    }

    // R2 deletes are idempotent; a missing key is not an error.
    await deleteObject(env.WATCHTHATSITE_BUCKET, parsed.key);
    console.log(JSON.stringify({ message: "object deleted", key: parsed.key }));
    return new Response(null, { status: 204 });
}

export async function handleList(
    request: Request,
    env: Env,
): Promise<Response> {
    const params = new URL(request.url).searchParams;

    const prefix = params.get("prefix");
    if (prefix === null || !isAllowedListPrefix(prefix)) {
        return jsonError(
            400,
            "invalid_prefix",
            "A prefix starting with 'captures/', 'changes/', 'state/' or 'steps/' is required.",
        );
    }

    let limit = DEFAULT_LIST_LIMIT;
    const rawLimit = params.get("limit");
    if (rawLimit !== null) {
        limit = Number(rawLimit);
        if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > MAX_LIST_LIMIT
        ) {
            return jsonError(
                400,
                "invalid_limit",
                `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`,
            );
        }
    }

    const listing = await listObjects(env.WATCHTHATSITE_BUCKET, {
        prefix,
        cursor: params.get("cursor") ?? undefined,
        limit,
    });

    return Response.json({
        objects: listing.objects.map(object => ({
            ...summarize(object),
            url: "",
        })),
        cursor: listing.truncated ? listing.cursor : null,
        truncated: listing.truncated,
    });
}
