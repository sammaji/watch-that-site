import "server-only";

import { sql } from "@watchthatsite/db/pool";
import type { PlatformCredit } from "@watchthatsite/types";
import { PLATFORM_MODELS } from "@watchthatsite/types";
import { getPlatformCredit, listConnections } from "./connections/service";

/**
 * Usage for one account, read from the Bifrost gateway's request logs.
 *
 * Every model call an account makes goes through Bifrost with that account's
 * one virtual key, so filtering the logs by that key gives exactly the
 * account's usage: the WatchThatSite credit (the `wts` provider) and the
 * connections the owner added. Server code only: the admin credentials never
 * leave the server, and a browser only ever sees its own account's numbers.
 */

export const USAGE_PERIODS = ["24h", "7d", "30d"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export function isUsagePeriod(value: unknown): value is UsagePeriod {
    return (
        typeof value === "string" &&
        (USAGE_PERIODS as readonly string[]).includes(value)
    );
}

/** One provider the account used, as the page names it. */
export interface UsageProvider {
    /** Bifrost's provider name: `wts`, `openai`, `c-…` for a custom endpoint. */
    id: string;
    label: string;
    /** True for the WatchThatSite credit. */
    credit: boolean;
}

export interface UsageBucket {
    /** Start of the bucket, ISO 8601. */
    at: string;
    /** Cost in US dollars per provider id. */
    cost: Record<string, number>;
    /** Cost in US dollars per model, keyed by `ModelUsage.key`. */
    modelCost: Record<string, number>;
    requests: number;
    failed: number;
    /** Input tokens read fresh (not from the provider's prompt cache). */
    inputTokens: number;
    /** Input tokens served from the provider's prompt cache. */
    cachedTokens: number;
    outputTokens: number;
}

/** Tokens one model used over the period. `total` is input + cache + output. */
export interface ModelTokens {
    /** Input read fresh, without the cache. */
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    total: number;
}

export interface ModelUsage {
    /** `provider::model`, unique across providers. */
    key: string;
    /** As the owner knows it, without a provider prefix: `wts-pro`, `gpt-5.4`. */
    model: string;
    tokens: ModelTokens;
    provider: string;
    requests: number;
    failed: number;
    costUsd: number;
}

/** One slice of the uptime strip: how a span of time's calls went. */
export interface UptimeSlice {
    /** Start of the slice, ISO 8601. */
    at: string;
    requests: number;
    failed: number;
}

export interface Usage {
    period: UsagePeriod;
    /** Length of one bucket in seconds (an hour for 24h, a day otherwise). */
    bucketSeconds: number;
    credit: Omit<PlatformCredit, "connection_id"> | null;
    totals: {
        requests: number;
        failed: number;
        tokens: number;
        costUsd: number;
        /** Of `costUsd`, what the credit paid. The rest is billed by the owner's providers. */
        creditCostUsd: number;
    };
    /** Every provider with usage in the period, the credit first. */
    providers: UsageProvider[];
    buckets: UsageBucket[];
    models: ModelUsage[];
    /** Finer than `buckets`, so the uptime strip has enough bars to read. */
    uptime: UptimeSlice[];
    uptimeSeconds: number;
    /** False when the gateway could not be read; the page says so. */
    available: boolean;
}

const CREDIT_PROVIDER = "wts";

/**
 * The gateway logs the model a routing rule sent the request to. Under the
 * credit those are our routed models; the owner chose an alias. The rule
 * names in `infra/bifrost.config.json` are the alias names.
 */
const CREDIT_MODEL_ALIASES: Record<string, string> = {
    "gpt-6.2-astra": "wts-pro",
    "gpt-6-luna": "wts-mini",
};

const BUILT_IN_LABELS: Record<string, string> = {
    wts: "WatchThatSite credit",
    openai: "OpenAI",
    anthropic: "Anthropic",
    azure: "Azure OpenAI",
    bedrock: "Amazon Bedrock",
    vertex: "Google Vertex AI",
    gemini: "Google Gemini",
    mistral: "Mistral",
    groq: "Groq",
    cohere: "Cohere",
    cerebras: "Cerebras",
    fireworks: "Fireworks",
    xai: "xAI",
    openrouter: "OpenRouter",
};

const CACHE_MS = 30_000;
const TIMEOUT_MS = 10_000;
const cache = new Map<string, { at: number; usage: Usage }>();

class LogsUnavailable extends Error {}

async function logs<T>(
    path: string,
    query: Record<string, string>,
): Promise<T> {
    const base = process.env.BIFROST_URL?.trim().replace(/\/+$/, "");
    const user = process.env.BIFROST_ADMIN_USERNAME ?? "";
    const pass = process.env.BIFROST_ADMIN_PASSWORD ?? "";
    if (!base || !user || !pass) throw new LogsUnavailable("not configured");
    const qs = new URLSearchParams(query).toString();
    let response: Response;
    try {
        response = await fetch(`${base}${path}?${qs}`, {
            headers: {
                Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
            },
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        throw new LogsUnavailable("unreachable");
    }
    if (!response.ok) throw new LogsUnavailable(`HTTP ${response.status}`);
    return (await response.json()) as T;
}

type Bucket<T> = { timestamp: string } & T;
type Histogram<T> = { buckets: Bucket<T>[]; bucket_size_seconds: number };

type StatsResponse = {
    total_requests: number;
    total_tokens: number;
    total_cost: number;
    success_rate: number;
};
type RequestsBucket = { count: number; success: number; error: number };
type TokensBucket = {
    prompt_tokens: number;
    completion_tokens: number;
    cached_read_tokens?: number;
};
type ProviderCostBucket = { by_provider: Record<string, number> };
type ModelCostBucket = { by_model: Record<string, number> };
type ModelCountBucket = {
    by_model: Record<string, { total: number; success: number; error: number }>;
};

function emptyUsage(period: UsagePeriod, credit: Usage["credit"]): Usage {
    return {
        period,
        bucketSeconds: period === "24h" ? 3600 : 86400,
        credit,
        totals: {
            requests: 0,
            failed: 0,
            tokens: 0,
            costUsd: 0,
            creditCostUsd: 0,
        },
        providers: [],
        buckets: [],
        models: [],
        uptime: [],
        uptimeSeconds: UPTIME_SLICE_S[period],
        available: false,
    };
}

/** Sums a model histogram over the period, for one side (credit or own keys). */
async function modelUsage(
    base: Record<string, string>,
    provider: string,
    credit: boolean,
): Promise<{
    rows: ModelUsage[];
    buckets: Map<string, Record<string, number>>;
}> {
    const query = { ...base, providers: provider };
    const [counts, costs] = await Promise.all([
        logs<Histogram<ModelCountBucket>>("/api/logs/histogram/models", query),
        logs<Histogram<ModelCostBucket>>("/api/logs/histogram/cost", query),
    ]);
    const rows = new Map<string, ModelUsage>();
    const nameOf = (model: string) =>
        credit ? (CREDIT_MODEL_ALIASES[model] ?? model) : model;
    const row = (model: string) => {
        const name = nameOf(model);
        let r = rows.get(name);
        if (!r) {
            r = {
                key: `${provider}::${name}`,
                model: name,
                tokens: {
                    input: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    output: 0,
                    total: 0,
                },
                provider,
                requests: 0,
                failed: 0,
                costUsd: 0,
            };
            rows.set(name, r);
        }
        return r;
    };
    for (const b of counts.buckets) {
        for (const [model, c] of Object.entries(b.by_model ?? {})) {
            if (!model) continue;
            const r = row(model);
            r.requests += c.total;
            r.failed += c.error;
        }
    }
    const buckets = new Map<string, Record<string, number>>();
    for (const b of costs.buckets) {
        const at: Record<string, number> = {};
        for (const [model, cost] of Object.entries(b.by_model ?? {})) {
            if (!model || cost <= 0) continue;
            const r = row(model);
            r.costUsd += cost;
            at[r.key] = (at[r.key] ?? 0) + cost;
        }
        buckets.set(b.timestamp, at);
    }
    return {
        rows: [...rows.values()].filter(r => r.requests > 0 || r.costUsd > 0),
        buckets,
    };
}

const PERIOD_MS: Record<UsagePeriod, number> = {
    "24h": 24 * 3600_000,
    "7d": 7 * 86400_000,
    "30d": 30 * 86400_000,
};
/** Uptime slice widths: 48, 42 and 60 bars. */
const UPTIME_SLICE_S: Record<UsagePeriod, number> = {
    "24h": 1800,
    "7d": 4 * 3600,
    "30d": 12 * 3600,
};
const LOG_PAGE = 1000;
/** Enough for any one account at this scale; past it the totals undercount. */
const MAX_LOG_PAGES = 25;

type LogEntry = {
    provider: string;
    model: string;
    timestamp: string;
    status: string;
    token_usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
            cached_write_tokens?: number;
            cache_write_tokens?: number;
        };
    } | null;
};

/**
 * Tokens per model, from the request log itself: the gateway's aggregates
 * count tokens per provider but not per model, and none counts cache writes,
 * which only the individual requests carry. Keyed like `ModelUsage.key`.
 */
async function scanLogs(
    virtualKeyId: string,
    period: UsagePeriod,
): Promise<{ tokens: Map<string, ModelTokens>; uptime: UptimeSlice[] }> {
    const startMs = Date.now() - PERIOD_MS[period];
    const start = new Date(startMs).toISOString();
    const out = new Map<string, ModelTokens>();
    // Slices aligned to their width, the oldest covering the period's start.
    const width = UPTIME_SLICE_S[period] * 1000;
    const first = Math.floor(startMs / width) * width;
    const slices: UptimeSlice[] = [];
    for (let t = first; t <= Date.now(); t += width) {
        slices.push({ at: new Date(t).toISOString(), requests: 0, failed: 0 });
    }
    for (let page = 0; page < MAX_LOG_PAGES; page++) {
        const res = await logs<{
            logs: LogEntry[];
            pagination: { total_count: number };
        }>("/api/logs", {
            virtual_key_ids: virtualKeyId,
            start_time: start,
            limit: String(LOG_PAGE),
            offset: String(page * LOG_PAGE),
            sort_by: "timestamp",
            order: "asc",
        });
        for (const l of res.logs ?? []) {
            const slice =
                slices[Math.floor((Date.parse(l.timestamp) - first) / width)];
            if (slice && (l.status === "success" || l.status === "error")) {
                slice.requests++;
                if (l.status === "error") slice.failed++;
            }
            const u = l.token_usage;
            if (!u || !l.model) continue;
            const name =
                l.provider === CREDIT_PROVIDER ?
                    (CREDIT_MODEL_ALIASES[l.model] ?? l.model)
                :   l.model;
            const key = `${l.provider}::${name}`;
            const t = out.get(key) ?? {
                input: 0,
                cacheRead: 0,
                cacheWrite: 0,
                output: 0,
                total: 0,
            };
            const prompt = u.prompt_tokens ?? 0;
            const read = u.prompt_tokens_details?.cached_tokens ?? 0;
            const write =
                u.prompt_tokens_details?.cache_write_tokens ??
                u.prompt_tokens_details?.cached_write_tokens ??
                0;
            const output = u.completion_tokens ?? 0;
            // Prompt tokens include what was read from and written to the cache.
            t.input += Math.max(0, prompt - read - write);
            t.cacheRead += read;
            t.cacheWrite += write;
            t.output += output;
            t.total += prompt + output;
            out.set(key, t);
        }
        if ((page + 1) * LOG_PAGE >= (res.pagination?.total_count ?? 0)) break;
    }
    return { tokens: out, uptime: slices };
}

/** The account's usage over a period. Never throws for a gateway problem. */
export async function readUsage(
    userId: string,
    period: UsagePeriod,
): Promise<Usage> {
    const key = `${userId}:${period}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.usage;

    const connections = await listConnections(userId);
    const creditRow = await getPlatformCredit(userId).catch(() => null);
    const credit =
        creditRow ?
            {
                limit_usd: creditRow.limit_usd,
                used_usd: creditRow.used_usd,
                left_usd: creditRow.left_usd,
            }
        :   null;

    const [vk] = await sql<{ bifrostId: string }[]>`
        SELECT bifrost_id FROM virtual_keys WHERE user_id = ${userId}
    `;
    if (!vk) return emptyUsage(period, credit);

    const base = { virtual_key_ids: vk.bifrostId, period };
    const ownProviders = [
        ...new Set(
            connections.filter(c => !c.managed).map(c => c.gateway_provider),
        ),
    ];

    let usage: Usage;
    try {
        // The model histograms do not say which provider served a model, so
        // the credit and each of the owner's providers are asked on their own.
        const [stats, requests, tokens, providerCost, ...perProvider] =
            await Promise.all([
                logs<StatsResponse>("/api/logs/stats", base),
                logs<Histogram<RequestsBucket>>("/api/logs/histogram", base),
                logs<Histogram<TokensBucket>>(
                    "/api/logs/histogram/tokens",
                    base,
                ),
                logs<Histogram<ProviderCostBucket>>(
                    "/api/logs/histogram/cost/by-provider",
                    base,
                ),
                modelUsage(base, CREDIT_PROVIDER, true),
                ...ownProviders.map(p => modelUsage(base, p, false)),
            ]);
        const models = perProvider.flatMap(p => p.rows);
        const scanned = await scanLogs(vk.bifrostId, period);
        for (const m of models) {
            const t = scanned.tokens.get(m.key);
            if (t) m.tokens = t;
        }

        const byAt = new Map<string, UsageBucket>();
        const bucket = (at: string) => {
            let b = byAt.get(at);
            if (!b) {
                b = {
                    at,
                    cost: {},
                    requests: 0,
                    failed: 0,
                    modelCost: {},
                    inputTokens: 0,
                    cachedTokens: 0,
                    outputTokens: 0,
                };
                byAt.set(at, b);
            }
            return b;
        };
        for (const b of requests.buckets) {
            const x = bucket(b.timestamp);
            x.requests = b.count;
            x.failed = b.error;
        }
        for (const b of tokens.buckets) {
            const x = bucket(b.timestamp);
            // Bifrost counts cached reads inside prompt tokens.
            x.cachedTokens = b.cached_read_tokens ?? 0;
            x.inputTokens = Math.max(0, b.prompt_tokens - x.cachedTokens);
            x.outputTokens = b.completion_tokens;
        }
        const seen = new Set<string>();
        for (const b of providerCost.buckets) {
            const x = bucket(b.timestamp);
            for (const [provider, cost] of Object.entries(
                b.by_provider ?? {},
            )) {
                if (!provider || cost <= 0) continue;
                x.cost[provider] = cost;
                seen.add(provider);
            }
        }
        for (const p of perProvider) {
            for (const [at, costs] of p.buckets) {
                Object.assign(bucket(at).modelCost, costs);
            }
        }
        for (const m of models) {
            if (m.provider) seen.add(m.provider);
        }

        const names = new Map(
            connections
                .filter(c => !c.managed)
                .map(c => [c.gateway_provider, c.name] as const),
        );
        const providers: UsageProvider[] = [...seen]
            .map(id => ({
                id,
                credit: id === CREDIT_PROVIDER,
                // A custom endpoint is its own provider, named after the
                // connection; a built-in provider keeps its own name.
                label: BUILT_IN_LABELS[id] ?? names.get(id) ?? id,
            }))
            .sort((a, b) =>
                a.credit !== b.credit ?
                    a.credit ?
                        -1
                    :   1
                :   a.label.localeCompare(b.label),
            );

        const buckets = [...byAt.values()].sort((a, b) =>
            a.at.localeCompare(b.at),
        );
        const creditCostUsd = buckets.reduce(
            (sum, b) => sum + (b.cost[CREDIT_PROVIDER] ?? 0),
            0,
        );
        const failed = buckets.reduce((sum, b) => sum + b.failed, 0);

        usage = {
            period,
            bucketSeconds:
                requests.bucket_size_seconds ||
                (period === "24h" ? 3600 : 86400),
            credit,
            totals: {
                requests: stats.total_requests,
                failed,
                tokens: stats.total_tokens,
                costUsd: stats.total_cost,
                creditCostUsd,
            },
            providers,
            buckets,
            uptime: scanned.uptime,
            uptimeSeconds: UPTIME_SLICE_S[period],
            models: models.sort(
                (a, b) => b.costUsd - a.costUsd || b.requests - a.requests,
            ),
            available: true,
        };
    } catch (error) {
        if (!(error instanceof LogsUnavailable)) throw error;
        return emptyUsage(period, credit);
    }

    cache.set(key, { at: Date.now(), usage });
    return usage;
}

/** The credit models, for the page's explanation of what the credit covers. */
export const CREDIT_MODELS = PLATFORM_MODELS;
