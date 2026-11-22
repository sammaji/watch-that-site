/**
 * Access control for the object API.
 *
 * - Writes, deletes and listing require the shared bearer token.
 * - Reads (`GET`/`HEAD` on a key) require either the bearer token or a valid
 *   signed query `?exp=<unix seconds>&sig=<hex>`; see `shared/signing.ts`.
 *   There are no public reads.
 */

import {
    BEARER_CACHE_CONTROL,
    MAX_SIGNED_CACHE_SECONDS,
    jsonError,
    unauthorized,
} from "./http.js";
import { objectSignature } from "./shared/signing.js";

const BEARER = /^Bearer (.+)$/i;
const EXP = /^[0-9]{1,15}$/;
const SIG = /^[0-9a-f]{64}$/;

function digest(value: string): Promise<ArrayBuffer> {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Constant-time string comparison: both sides are hashed to a fixed size first. */
async function safeEqual(a: string, b: string): Promise<boolean> {
    const [left, right] = await Promise.all([digest(a), digest(b)]);
    return crypto.subtle.timingSafeEqual(left, right);
}

function notConfigured(name: string): Response {
    console.error(
        JSON.stringify({
            message: `${name} is not configured; refusing request`,
        }),
    );
    return jsonError(
        500,
        "not_configured",
        `Server is missing its ${name} configuration.`,
    );
}

/**
 * Returns a Response to send when the request is not authorized, or null when
 * it is.
 */
export async function requireBearer(
    request: Request,
    env: Env,
): Promise<Response | null> {
    const expected = env.R2_API_TOKEN;
    if (!expected) {
        return notConfigured("R2_API_TOKEN");
    }

    const match = BEARER.exec(request.headers.get("authorization") ?? "");
    if (match === null) {
        return unauthorized("A bearer token is required.");
    }
    if (!(await safeEqual(match[1], expected))) {
        return unauthorized("Invalid bearer token.");
    }
    return null;
}

export type ReadGrant =
    { ok: true; cacheControl: string } | { ok: false; response: Response };

/**
 * Authorizes a read of `key`. A request carrying an `Authorization` header is
 * judged on the bearer token alone; otherwise it needs a valid, unexpired
 * signature. Anything else is 401.
 */
export async function authorizeRead(
    request: Request,
    env: Env,
    key: string,
    now: number = Date.now(),
): Promise<ReadGrant> {
    if (request.headers.has("authorization")) {
        const denied = await requireBearer(request, env);
        return denied === null ?
                { ok: true, cacheControl: BEARER_CACHE_CONTROL }
            :   { ok: false, response: denied };
    }

    const params = new URL(request.url).searchParams;
    const rawExp = params.get("exp");
    const sig = params.get("sig");
    if (rawExp === null && sig === null) {
        return {
            ok: false,
            response: unauthorized(
                "A bearer token or a signed URL is required to read objects.",
            ),
        };
    }

    const secret = env.R2_SIGNING_SECRET;
    if (!secret) {
        return { ok: false, response: notConfigured("R2_SIGNING_SECRET") };
    }

    if (
        rawExp === null ||
        sig === null ||
        !EXP.test(rawExp) ||
        !SIG.test(sig)
    ) {
        return {
            ok: false,
            response: unauthorized("Malformed signature.", "invalid_signature"),
        };
    }

    const exp = Number(rawExp);
    const remaining = exp - Math.floor(now / 1000);
    if (remaining <= 0) {
        return {
            ok: false,
            response: unauthorized(
                "Signed URL has expired.",
                "expired_signature",
            ),
        };
    }

    const expected = await objectSignature(secret, key, exp);
    if (!(await safeEqual(sig, expected))) {
        return {
            ok: false,
            response: unauthorized("Invalid signature.", "invalid_signature"),
        };
    }

    return {
        ok: true,
        cacheControl: `private, max-age=${Math.min(remaining, MAX_SIGNED_CACHE_SECONDS)}`,
    };
}
