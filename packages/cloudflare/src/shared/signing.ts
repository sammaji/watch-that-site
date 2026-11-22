/**
 * Signed read URLs for the object-store Worker.
 *
 * Objects are private. A reader that does not hold the bearer token gets a
 * short-lived URL of the form
 *
 * ```
 * {baseUrl}/objects/{key}?exp={unix seconds}&sig={hex}
 * sig = hex(HMAC-SHA256(R2_SIGNING_SECRET, key + "\n" + exp))
 * ```
 *
 * `exp` is written as a base-10 integer with no padding, `sig` as lower-case
 * hex. The Worker recomputes the signature over the decoded key it serves, so
 * the key must be signed exactly as it appears in the path (keys only contain
 * `[a-z0-9./-]`, so no percent-encoding is involved).
 *
 * The same algorithm lives in `packages/cloudflare_go/r2/sign.go` and
 * `apps/web/lib/objects.ts`; a shared test vector pins all three.
 *
 * Uses WebCrypto only, so it runs unchanged in Workers, Node 20+ and browsers.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
}

function toHex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes), b =>
        b.toString(16).padStart(2, "0"),
    ).join("");
}

/** The message that gets signed: `key + "\n" + exp`. */
export function signingPayload(key: string, exp: number): string {
    return `${key}\n${exp}`;
}

/** Hex HMAC-SHA256 signature for `key` expiring at `exp` (unix seconds). */
export async function objectSignature(
    secret: string,
    key: string,
    exp: number,
): Promise<string> {
    if (!secret) {
        throw new TypeError("objectSignature: a signing secret is required");
    }
    if (!Number.isSafeInteger(exp) || exp < 0) {
        throw new TypeError(
            `objectSignature: exp must be a unix timestamp, got ${exp}`,
        );
    }
    const mac = await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret),
        encoder.encode(signingPayload(key, exp)),
    );
    return toHex(mac);
}

/**
 * Builds `{baseUrl}/objects/{key}?exp=..&sig=..`. `baseUrl` is the Worker
 * origin (e.g. `http://localhost:8787`); trailing slashes are ignored.
 */
export async function signObjectUrl(
    baseUrl: string,
    secret: string,
    key: string,
    exp: number,
): Promise<string> {
    const sig = await objectSignature(secret, key, exp);
    return `${baseUrl.replace(/\/+$/, "")}/objects/${key}?exp=${exp}&sig=${sig}`;
}

/** {@link signObjectUrl} with `exp = now + ttlSeconds`. */
export function signObjectUrlFor(
    baseUrl: string,
    secret: string,
    key: string,
    ttlSeconds: number,
    now: Date = new Date(),
): Promise<string> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new TypeError(`ttlSeconds must be positive, got ${ttlSeconds}`);
    }
    const exp = Math.floor(now.getTime() / 1000) + Math.ceil(ttlSeconds);
    return signObjectUrl(baseUrl, secret, key, exp);
}
