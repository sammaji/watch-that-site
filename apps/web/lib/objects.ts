/**
 * Private object store access for the web app (server-only).
 *
 * Objects live behind the object-store Worker (`packages/cloudflare`) and are
 * never public. The browser asks `/api/v1/objects/{key}`; that route checks
 * the viewer can see the Monitor in the key and then hands out a short-lived
 * signed Worker URL built here.
 *
 * The key grammar and the signature algorithm are copies of
 * `packages/cloudflare/src/shared/{keys,signing}.ts` (the web app does not
 * depend on that package). Keep them in sync; the shared test vector in
 * `packages/cloudflare/test/signing.test.ts` and
 * `packages/cloudflare_go/r2/sign_test.go` documents the expected output:
 *
 *   key    = "changes/8dea949d-d40b-49f6-8f9a-9e31f891eb4e/2136440b-8e77-4a2d-8fe2-fcaea8af11f7.json.gz"
 *   secret = "wts-test-vector-secret", exp = 1790000000
 *   sig    = "8930f280ad5550761f7abe127901c6c59d04d4c7004add5819cc21d987e14592"
 */

/** TTL of the signed URLs this app hands to browsers. */
export const OBJECT_URL_TTL_SECONDS = 5 * 60;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const OBJECT_KEY = new RegExp(
    [
        `^captures/(${UUID})/${UUID}/shot\\.(?:png|webp)$`,
        `^captures/(${UUID})/${UUID}/blocks\\.json\\.gz$`,
        `^changes/(${UUID})/${UUID}\\.json\\.gz$`,
        `^changes/(${UUID})/${UUID}-(?:diff|crop)\\.png$`,
        `^state/(${UUID})\\.json$`,
        // Step screenshots of a Run's Trace or a Macro recording
        // (`stepScreenshotKey` in packages/types/src/protocol.ts).
        `^steps/(${UUID})/${UUID}/(?:0|[1-9][0-9]{0,8})\\.webp$`,
    ].join("|"),
);

export type ObjectKeyInfo = {
    key: string;
    /** The Monitor that owns the object: always the first UUID in the key. */
    monitorId: string;
    /** True for `.json.gz` objects (blocks and Change Records). */
    gzipJson: boolean;
};

/** Parses a key in the object-store layout, or returns null. */
export function parseObjectKey(key: string): ObjectKeyInfo | null {
    const match = OBJECT_KEY.exec(key);
    if (!match) return null;
    const monitorId = match.slice(1).find(Boolean);
    if (!monitorId) return null;
    return { key, monitorId, gzipJson: key.endsWith(".json.gz") };
}

const encoder = new TextEncoder();

/** hex(HMAC-SHA256(secret, key + "\n" + exp)) */
export async function objectSignature(
    secret: string,
    key: string,
    exp: number,
): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const mac = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        encoder.encode(`${key}\n${exp}`),
    );
    return Array.from(new Uint8Array(mac), b =>
        b.toString(16).padStart(2, "0"),
    ).join("");
}

/** `{workerUrl}/objects/{key}?exp=..&sig=..`, valid for `ttlSeconds`. */
export async function signObjectUrl(
    workerUrl: string,
    secret: string,
    key: string,
    ttlSeconds: number = OBJECT_URL_TTL_SECONDS,
): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + Math.ceil(ttlSeconds);
    const sig = await objectSignature(secret, key, exp);
    return `${workerUrl.replace(/\/+$/, "")}/objects/${key}?exp=${exp}&sig=${sig}`;
}

export type ObjectStoreConfig = {
    workerUrl: string;
    signingSecret: string;
};

/** Reads `R2_WORKER_URL` and `R2_SIGNING_SECRET`, or null when either is unset. */
export function objectStoreConfig(): ObjectStoreConfig | null {
    const workerUrl = process.env.R2_WORKER_URL?.trim();
    const signingSecret = process.env.R2_SIGNING_SECRET?.trim();
    if (!workerUrl || !signingSecret) return null;
    return { workerUrl, signingSecret };
}

/** The columns server code needs to act on a Monitor for its owner. */
export type VisibleMonitor = {
    id: string;
    user_id: string;
};

/**
 * The Monitor `id` as the PostgREST caller identified by `jwt` sees it, or
 * null. Row-level security decides: another user's Monitor simply comes
 * back as zero rows.
 */
export async function visibleMonitor(
    id: string,
    jwt: string,
): Promise<VisibleMonitor | null> {
    const base = process.env.NEXT_PUBLIC_POSTGREST_URL;
    if (!base) {
        throw new Error("NEXT_PUBLIC_POSTGREST_URL is not configured.");
    }
    const url = `${base.replace(/\/+$/, "")}/monitors?id=eq.${encodeURIComponent(id)}&select=id,user_id`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw new Error(`PostgREST responded ${response.status}`);
    }
    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0] as VisibleMonitor;
}

/** True when the PostgREST caller identified by `jwt` can see Monitor `id`. */
export async function canSeeMonitor(id: string, jwt: string): Promise<boolean> {
    return (await visibleMonitor(id, jwt)) !== null;
}
