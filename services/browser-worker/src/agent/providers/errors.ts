import { sleep } from "../../lib/stabilize.js";

/** A model call that failed for good: bad key, quota, outage, bad request. */
export class ProviderError extends Error {
    readonly status: number | null;
    readonly retryable: boolean;
    readonly retryAfterMs: number | undefined;

    constructor(
        message: string,
        opts: {
            status?: number | null;
            retryable?: boolean;
            retryAfterMs?: number | undefined;
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: opts.cause });
        this.name = "ProviderError";
        this.status = opts.status ?? null;
        this.retryable = opts.retryable ?? false;
        this.retryAfterMs = opts.retryAfterMs;
    }
}

/** What the owner reads when the platform credit has run out. */
export const CREDIT_USED_UP =
    "Your WatchThatSite credit is used up. Add your own model connection to keep checking pages.";

/**
 * The model gateway (Bifrost) refuses a request whose budget is spent with
 * 402 and `{"type": "budget_exceeded", "error": {"message": "Budget
 * exceeded: ..."}}`. Waiting does not help, so it is never retried. On the
 * platform credit it means the credit is used up; a connection of the
 * owner's own carries no budget, so there it is reported as the gateway said
 * it.
 */
export function budgetError(
    status: number | null,
    message: string,
    connection: { managed?: boolean | undefined },
    apiKey: string,
    cause: unknown,
): ProviderError | null {
    if (status !== 402 || !/budget/i.test(message)) return null;
    return new ProviderError(
        connection.managed ? CREDIT_USED_UP : (
            scrubKey(
                `The model gateway refused the request: ${message}`,
                apiKey,
            )
        ),
        { status, retryable: false, cause },
    );
}

/**
 * Headers for every request to the gateway: the provider key to use, when the
 * connection names one (see ResolvedConnection.keyId).
 */
export function gatewayHeaders(connection: {
    keyId?: string | null | undefined;
}): Record<string, string> {
    return connection.keyId ? { "x-bf-api-key-id": connection.keyId } : {};
}

/** Removes the connection's key from provider text, and bounds its length. */
export function scrubKey(message: string, apiKey: string): string {
    let out = message;
    if (apiKey.length >= 6) out = out.split(apiKey).join("[redacted]");
    // Providers echo a masked key ("sk-...abcd") in auth errors; drop long
    // key-shaped tokens too, in case a proxy echoes the real one differently.
    out = out.replace(/\b(sk|key)-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
    return out.slice(0, 600);
}

type HeaderBag =
    Headers | Record<string, string | undefined> | null | undefined;

/** `retry-after-ms` or `retry-after` (seconds or an HTTP date), in ms. */
export function parseRetryAfter(headers: HeaderBag): number | undefined {
    if (!headers) return undefined;
    const get = (name: string): string | null | undefined =>
        typeof (headers as Headers).get === "function" ?
            (headers as Headers).get(name)
        :   (headers as Record<string, string | undefined>)[name];
    const ms = get("retry-after-ms");
    if (ms && !Number.isNaN(Number(ms))) return Math.max(0, Number(ms));
    const value = get("retry-after");
    if (!value) return undefined;
    const seconds = Number(value);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 429 and 5xx (Anthropic's 529 included) are worth another try; so is a dropped connection. */
export function retryableStatus(status: number | null): boolean {
    return status === null || status === 408 || status === 429 || status >= 500;
}

export const retryDelaysMs = [500, 1_500, 4_000];
/** A provider asking for a longer wait than this is treated as down. */
export const maxRetryAfterMs = 30_000;

/**
 * Runs `call`, retrying a ProviderError marked retryable with backoff. A
 * `retry-after` from the provider replaces the backoff delay.
 */
export async function withRetries<T>(
    call: () => Promise<T>,
    opts: {
        signal?: AbortSignal | undefined;
        delaysMs?: number[];
        wait?: (ms: number) => Promise<void>;
    } = {},
): Promise<T> {
    const delays = opts.delaysMs ?? retryDelaysMs;
    const wait = opts.wait ?? sleep;
    for (let attempt = 0; ; attempt++) {
        try {
            return await call();
        } catch (err) {
            if (
                !(err instanceof ProviderError) ||
                !err.retryable ||
                attempt >= delays.length ||
                opts.signal?.aborted
            ) {
                throw err;
            }
            const delay = err.retryAfterMs ?? delays[attempt]!;
            if (delay > maxRetryAfterMs) throw err;
            await wait(delay);
        }
    }
}
