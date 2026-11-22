/**
 * Shared HTTP helpers, limits, and error shapes for the object API.
 */

/** Maximum size, in bytes, accepted for a single uploaded object. */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/** Cache-Control for reads authorised by the bearer token. */
export const BEARER_CACHE_CONTROL = "private, no-store";

/** Longest a signed read may be cached by the client, in seconds. */
export const MAX_SIGNED_CACHE_SECONDS = 300;

/** Every error response shares this shape: `{ "error": { "code", "message" } }`. */
export function jsonError(
    status: number,
    code: string,
    message: string,
): Response {
    return Response.json({ error: { code, message } }, { status });
}

export function methodNotAllowed(allow: string[]): Response {
    const response = jsonError(
        405,
        "method_not_allowed",
        `Allowed methods: ${allow.join(", ")}.`,
    );
    response.headers.set("Allow", allow.join(", "));
    return response;
}

export function unauthorized(
    message: string,
    code: string = "unauthorized",
): Response {
    const response = jsonError(401, code, message);
    response.headers.set("WWW-Authenticate", "Bearer");
    return response;
}
