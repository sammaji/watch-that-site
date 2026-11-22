/**
 * A Monitor as the owner configures it: a URL, instructions in plain words,
 * how often to check, and which model the agent uses. There are no monitor
 * types, scopes, triggers or rules: the agent reads the instructions and
 * decides what counts as a Change.
 *
 * Mirrors the `monitors` table (packages/db/migrations/schema.sql) and
 * services/scheduler/internal/monitor/config.go.
 */

import type { WatchPlan } from "./watch-plan";

/** A rectangle `[x, y, w, h]` in screenshot pixels. */
export type Rect = [number, number, number, number];

export type Urgency = "instant" | "hourly" | "daily";

/** `draft`: made by the create form for a recording; not scheduled or listed. */
export type MonitorStatus = "active" | "paused" | "draft";

/** A `monitors` row. */
export interface Monitor {
    id: string;
    user_id: string;
    name: string;
    url: string;
    /** `null`: runs on demand only. */
    interval_minutes: number | null;
    /** What to watch for and what to ignore, in the owner's words. */
    instructions: string;
    /** The model connection the agent uses; `null` until one is chosen. */
    connection_id: string | null;
    model: string | null;
    /** How the Agent decided the page should be watched; null before the first plan. */
    watch_plan: WatchPlan | null;
    /** Re-check a Change on the next Run before alerting. */
    confirm_changes: boolean;
    urgency: Urgency;
    snoozed_until: string | null;
    extra_wait_ms: number;
    block_ads: boolean;
    viewport_w: number;
    viewport_h: number;
    status: MonitorStatus;
    created_at: string;
    updated_at: string;
}

/** Used when a Monitor has no instructions. */
export const DEFAULT_INSTRUCTIONS =
    "Tell me about any meaningful change to the content of this page. Ignore dates, counters, ads and rotating content.";

/**
 * What a connection is: a provider of the Bifrost model gateway (`openai`,
 * `anthropic`, `azure`, `bedrock`, `vertex`, `gemini`, ...), `wts` for the
 * platform credit, or, for a custom endpoint (a connection with a base URL),
 * the API that endpoint speaks (`openai` or `anthropic`).
 */
export type ProviderKind = string;

/** The two APIs a custom endpoint can speak. */
export type EndpointKind = "openai" | "anthropic";

/** The public endpoint each API stands for when a connection has no base URL. */
export const PUBLIC_BASE_URLS: Record<EndpointKind, string> = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com/v1",
};

/**
 * A `provider_connections` row as the browser sees it. Secrets (API keys,
 * cloud credentials) live only in the Bifrost gateway; `api_key_hint` is the
 * last four characters of the key. Every model call goes through the gateway
 * with the account's virtual key, so `base_url` and `settings` are what the
 * owner entered, shown back to them, and never read to make a request.
 */
export interface ProviderConnection {
    id: string;
    user_id: string;
    kind: ProviderKind;
    name: string;
    /** A custom endpoint's URL as the owner entered it; `null` otherwise. */
    base_url: string | null;
    /**
     * The provider's settings that are not secret, kept for display: Azure
     * `endpoint`, `api_version` and `deployments`, Bedrock `region`, Vertex
     * `project_id` and `region`, a self-hosted server's `url`, and so on.
     */
    settings: Record<string, unknown>;
    /**
     * The gateway provider the models live under: `wts` (platform credit),
     * the provider itself, or `c-…` (a custom endpoint of its own).
     */
    gateway_provider: string;
    api_key_hint: string;
    /** Gateway model strings the owner enabled: `<gateway_provider>/<model>`. */
    models: string[];
    default_model: string | null;
    /**
     * The platform-credit connection every account gets. The server creates
     * and keeps it; the owner cannot edit or delete it. Its models are
     * PLATFORM_MODELS.
     */
    managed: boolean;
    enabled: boolean;
    /**
     * The key's status as the model gateway records it (it lists models with
     * every key when it is added and again in the background). Not a column:
     * the API reads it from the gateway. `null` for the platform credit, or
     * when the gateway cannot be asked.
     */
    status: ConnectionStatus | null;
    created_at: string;
    updated_at: string;
}

/**
 * A provider key's status in the gateway: `working` when its last model
 * listing succeeded, `failing` with the provider's error when it did not,
 * `unknown` when the gateway has not checked it yet. The gateway keeps no
 * time for it.
 */
export interface ConnectionStatus {
    state: "working" | "failing" | "unknown";
    error: string | null;
}

/** What is left of the platform credit, as the gateway reports it. */
export interface PlatformCredit {
    connection_id: string;
    limit_usd: number;
    used_usd: number;
    left_usd: number;
}

/** A `monitor_secrets` row. The value is never readable. */
export interface MonitorSecret {
    id: string;
    monitor_id: string;
    name: string;
    hint: string;
    created_at: string;
}

/**
 * The models the platform-credit connection offers, as the Bifrost gateway
 * names them: `wts` is a custom provider there (OpenAI-compatible, on our own
 * OpenAI key), and each alias is routed to a real model. The account's
 * virtual key may use only this provider, and its budget is the credit, so
 * the credit can be spent on these models and nothing else.
 */
export const PLATFORM_MODELS = ["wts/wts-pro", "wts/wts-mini"] as const;

export type PlatformModel = (typeof PLATFORM_MODELS)[number];

/** The model a new account's Monitors use until the owner picks another. */
export const DEFAULT_PLATFORM_MODEL: PlatformModel = "wts/wts-pro";

/** What each account starts with, in US dollars. */
export const PLATFORM_CREDIT_USD = 10;

/** The model for utility jobs when the owner has not chosen one. */
export const DEFAULT_UTILITY_MODEL: PlatformModel = "wts/wts-mini";

/** A `user_settings` row. */
export interface UserSettings {
    user_id: string;
    /**
     * The model for small jobs that are not a Monitor's: suggesting a
     * new Monitor's Instructions. Null: DEFAULT_UTILITY_MODEL on the credit.
     */
    utility_connection_id: string | null;
    utility_model: string | null;
    created_at: string;
    updated_at: string;
}
