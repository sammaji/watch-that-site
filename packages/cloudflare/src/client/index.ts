/**
 * Node client for the object-store Worker.
 *
 * Services outside Cloudflare (the browser worker) hold no R2 credentials;
 * they read and write through the Worker with a shared bearer token. Objects
 * are private: persist the **key**, never a URL. A reader without the token
 * gets a short-lived signed URL from {@link ObjectStoreClient.signedUrl} (or
 * from the web app's `/api/v1/objects/{key}` route).
 *
 * @example
 * ```ts
 * const store = createObjectStoreClient({
 *     baseUrl: process.env.R2_WORKER_URL!,
 *     token: process.env.R2_API_TOKEN!,
 * });
 * const key = captureShotKey(monitorId, runId, "webp");
 * await store.putObject(key, webp, { contentType: "image/webp" });
 * const state = await store.getStorageState(monitorId);
 * ```
 */

import {
    captureShotKey,
    isErrorBody,
    KEY_FORMAT_HINT,
    learnShotKey,
    parseObjectKey,
    signObjectUrlFor,
    storageStateKey,
    type ImageFormat,
    type ObjectListing,
    type StoredObject,
} from "../shared/index.js";

/** Largest object the Worker accepts, mirroring `MAX_OBJECT_BYTES` in `src/http.ts`. */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 250;

/** A request the Worker rejected, or that never reached it. */
export class ObjectStoreError extends Error {
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number;
    /** Machine-readable code from the Worker, or `network_error` / `invalid_response`. */
    readonly code: string;

    constructor(
        status: number,
        code: string,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = "ObjectStoreError";
        this.status = status;
        this.code = code;
    }

    /** True when the object does not exist. */
    get isNotFound(): boolean {
        return this.status === 404;
    }
}

/** Minimal `fetch` shape, so tests can inject the Worker's own handler. */
export type FetchLike = (
    input: string,
    init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: Uint8Array;
        signal?: AbortSignal;
    },
) => Promise<Response>;

export interface ObjectStoreClientOptions {
    /** Worker origin, e.g. `http://localhost:8787`. Trailing slashes are ignored. */
    baseUrl: string;
    /** Shared bearer token; required for every call. */
    token: string;
    /** `R2_SIGNING_SECRET`. Optional; only {@link ObjectStoreClient.signedUrl} needs it. */
    signingSecret?: string;
    /** Override the transport. Defaults to the global `fetch`. */
    fetch?: FetchLike;
    /** Per-request timeout. Default 30s. */
    timeoutMs?: number;
    /** Retries for network failures and 5xx. Default 1. Writes are idempotent, so this is safe. */
    retries?: number;
}

export interface UploadOptions {
    /** MIME type to store. Default: derived from the key's extension. */
    contentType?: string;
}

export interface ListOptions {
    /** Continue a previous listing. */
    cursor?: string;
    /** Page size, 1–1000. */
    limit?: number;
}

export interface ObjectStoreClient {
    /** Stores `body` at `key`, replacing anything already there. */
    putObject(
        key: string,
        body: Uint8Array,
        options?: UploadOptions,
    ): Promise<StoredObject>;
    /** The bytes at `key` (bearer read), or null when it does not exist. */
    getObject(key: string): Promise<Uint8Array | null>;
    /** Metadata for `key`, or null when it does not exist. */
    headObject(key: string): Promise<StoredObject | null>;
    /** Removes `key`. Deleting something absent is not an error. */
    deleteObject(key: string): Promise<void>;
    /** One page of objects under `prefix`. */
    listObjects(prefix: string, options?: ListOptions): Promise<ObjectListing>;
    /**
     * A read URL for `key` valid for `ttlSeconds`, signed with `signingSecret`.
     * Throws when the client was built without one. Does not check the object exists.
     */
    signedUrl(key: string, ttlSeconds: number): Promise<string>;
    /** Stores the Capture screenshot at `captures/{m}/{r}/shot.{format}`. */
    uploadCaptureShot(
        monitorId: string,
        runId: string,
        bytes: Uint8Array,
        format: ImageFormat,
    ): Promise<StoredObject>;
    /** Stores learning-pass screenshot `index` (0–2) at `captures/{m}/{r}/learn-{i}.{format}`. */
    uploadLearnShot(
        monitorId: string,
        runId: string,
        index: number,
        bytes: Uint8Array,
        format: ImageFormat,
    ): Promise<StoredObject>;
    /** The Monitor's Playwright storage state (`state/{m}.json`), parsed, or null. */
    getStorageState<T = unknown>(monitorId: string): Promise<T | null>;
    /** Stores the Monitor's storage state. A string is stored as-is (it must be JSON). */
    putStorageState(
        monitorId: string,
        state: string | object,
    ): Promise<StoredObject>;
    /** The configured Worker origin, normalised. */
    readonly baseUrl: string;
}

export function createObjectStoreClient(
    options: ObjectStoreClientOptions,
): ObjectStoreClient {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
        throw new TypeError("createObjectStoreClient: baseUrl is required");
    }
    if (!options.token) {
        throw new TypeError("createObjectStoreClient: token is required");
    }

    const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;

    async function request(
        method: string,
        path: string,
        init: { headers?: Record<string, string>; body?: Uint8Array } = {},
    ): Promise<Response> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) {
                await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
            }

            let response: Response;
            try {
                response = await doFetch(`${baseUrl}${path}`, {
                    method,
                    headers: {
                        authorization: `Bearer ${options.token}`,
                        ...init.headers,
                    },
                    ...(init.body === undefined ? {} : { body: init.body }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                // The request never produced a response: DNS, connection reset,
                // timeout. Worth another attempt.
                lastError = error;
                continue;
            }

            // 5xx is the Worker failing, not the request being wrong, so it is
            // also retryable. Everything else is final.
            if (response.status < 500 || attempt === retries) {
                return response;
            }
            lastError = await describeError(response);
        }

        if (lastError instanceof ObjectStoreError) {
            throw lastError;
        }
        const message =
            lastError instanceof Error ? lastError.message : String(lastError);
        throw new ObjectStoreError(
            0,
            "network_error",
            `${method} ${path} failed: ${message}`,
            {
                cause: lastError,
            },
        );
    }

    async function requestJson<T>(
        method: string,
        path: string,
        init?: { headers?: Record<string, string>; body?: Uint8Array },
    ): Promise<T> {
        const response = await request(method, path, init);
        if (!response.ok) {
            throw await describeError(response);
        }
        return (await parseJson(response)) as T;
    }

    function objectPath(key: string): string {
        const parsed = parseObjectKey(key);
        if (parsed === null) {
            throw new ObjectStoreError(
                0,
                "invalid_key",
                `Invalid object key ${JSON.stringify(key)}: ${KEY_HINT}`,
            );
        }
        return `/objects/${key}`;
    }

    async function putObject(
        key: string,
        body: Uint8Array,
        uploadOptions: UploadOptions = {},
    ): Promise<StoredObject> {
        const path = objectPath(key);
        if (body.byteLength === 0) {
            throw new ObjectStoreError(
                0,
                "empty_body",
                `Refusing to upload an empty object to ${key}.`,
            );
        }
        if (body.byteLength > MAX_OBJECT_BYTES) {
            throw new ObjectStoreError(
                0,
                "payload_too_large",
                `Object for ${key} is ${body.byteLength} bytes, over the ${MAX_OBJECT_BYTES} byte limit.`,
            );
        }

        const contentType = uploadOptions.contentType ?? contentTypeForKey(key);
        return requestJson<StoredObject>("PUT", path, {
            headers: {
                "content-type": contentType,
                // The Worker requires a known length to stream into R2.
                "content-length": String(body.byteLength),
            },
            body,
        });
    }

    async function getObject(key: string): Promise<Uint8Array | null> {
        const path = objectPath(key);
        const response = await request("GET", path);
        if (response.status === 404) {
            return null;
        }
        if (!response.ok) {
            throw await describeError(response);
        }
        return new Uint8Array(await response.arrayBuffer());
    }

    return {
        baseUrl,

        putObject,

        getObject,

        signedUrl(key: string, ttlSeconds: number): Promise<string> {
            objectPath(key);
            if (!options.signingSecret) {
                throw new ObjectStoreError(
                    0,
                    "not_configured",
                    "signedUrl needs the signingSecret option (R2_SIGNING_SECRET).",
                );
            }
            return signObjectUrlFor(
                baseUrl,
                options.signingSecret,
                key,
                ttlSeconds,
            );
        },

        async headObject(key: string): Promise<StoredObject | null> {
            const path = objectPath(key);
            const response = await request("HEAD", path);
            if (response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw await describeError(response);
            }
            // HEAD has no body, so the summary is rebuilt from the headers.
            return {
                key,
                size: Number(response.headers.get("content-length") ?? 0),
                etag: (response.headers.get("etag") ?? "").replace(/"/g, ""),
                uploaded: response.headers.get("last-modified") ?? "",
                content_type: response.headers.get("content-type"),
                url: "",
            };
        },

        async deleteObject(key: string): Promise<void> {
            const path = objectPath(key);
            const response = await request("DELETE", path);
            if (!response.ok && response.status !== 404) {
                throw await describeError(response);
            }
        },

        async listObjects(
            prefix: string,
            listOptions: ListOptions = {},
        ): Promise<ObjectListing> {
            const params = new URLSearchParams({ prefix });
            if (listOptions.cursor) {
                params.set("cursor", listOptions.cursor);
            }
            if (listOptions.limit !== undefined) {
                params.set("limit", String(listOptions.limit));
            }
            return requestJson<ObjectListing>(
                "GET",
                `/objects?${params.toString()}`,
            );
        },

        uploadCaptureShot(monitorId, runId, bytes, format) {
            return putObject(captureShotKey(monitorId, runId, format), bytes);
        },

        uploadLearnShot(monitorId, runId, index, bytes, format) {
            return putObject(
                learnShotKey(monitorId, runId, index, format),
                bytes,
            );
        },

        async getStorageState<T = unknown>(
            monitorId: string,
        ): Promise<T | null> {
            const bytes = await getObject(storageStateKey(monitorId));
            if (bytes === null) {
                return null;
            }
            return JSON.parse(new TextDecoder().decode(bytes)) as T;
        },

        putStorageState(monitorId, state) {
            const text =
                typeof state === "string" ? state : JSON.stringify(state);
            return putObject(
                storageStateKey(monitorId),
                new TextEncoder().encode(text),
            );
        },
    };
}

const KEY_HINT = KEY_FORMAT_HINT;

function contentTypeForKey(key: string): string {
    return parseObjectKey(key)?.contentType ?? "application/octet-stream";
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new ObjectStoreError(
            response.status,
            "invalid_response",
            `Expected JSON from the object store, got: ${text.slice(0, 200)}`,
            { cause: error },
        );
    }
}

/** Turns a non-2xx response into an ObjectStoreError, preferring the Worker's own code. */
async function describeError(response: Response): Promise<ObjectStoreError> {
    let body: unknown;
    try {
        body = JSON.parse(await response.text()) as unknown;
    } catch {
        return new ObjectStoreError(
            response.status,
            "unknown_error",
            `Object store responded ${response.status}.`,
        );
    }
    if (isErrorBody(body)) {
        return new ObjectStoreError(
            response.status,
            body.error.code,
            body.error.message,
        );
    }
    return new ObjectStoreError(
        response.status,
        "unknown_error",
        `Object store responded ${response.status}.`,
    );
}

export {
    blocksKey,
    captureShotKey,
    changeCropKey,
    changeDiffKey,
    changeRecordKey,
    learnShotKey,
    objectSignature,
    parseObjectKey,
    signObjectUrl,
    signObjectUrlFor,
    storageStateKey,
} from "../shared/index.js";
export type {
    ImageFormat,
    ObjectKind,
    ObjectListing,
    ObjectPrefix,
    ParsedObjectKey,
    StoredObject,
} from "../shared/index.js";
