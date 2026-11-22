import "server-only";

import { createHash } from "node:crypto";

/**
 * The admin side of our Bifrost gateway (BIFROST_URL, basic auth with
 * BIFROST_ADMIN_USERNAME / BIFROST_ADMIN_PASSWORD): virtual keys, provider
 * keys and custom providers. Server code only; the browser never talks to
 * Bifrost, and nothing here returns a key value to it.
 *
 * Shapes follow Bifrost v2.6 (`docs/openapi/openapi.yaml` in the Bifrost
 * repository), trimmed to the fields this app reads or writes.
 */

/** Thrown when the gateway cannot be reached or refuses an admin call. */
export class GatewayError extends Error {
    readonly status: number | null;
    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = "GatewayError";
        this.status = status;
    }
}

/**
 * Every account's virtual key is named uuidv5(user id, this namespace): stable,
 * so the key can be found again by name, and it does not show the user id in
 * Bifrost. Never change it, or every account gets a second key.
 */
export const VIRTUAL_KEY_NAMESPACE = "7ebd4589-03a9-40fa-8311-7a451255accb";

/** The custom provider behind the platform credit (infra/bifrost.config.json). */
export const PLATFORM_PROVIDER = "wts";

/**
 * The real models the platform aliases route to. A virtual key's allowed
 * models are checked against the routed model, not the alias, so these are
 * what the `wts` provider config allows. Keep in step with the routing rules
 * in infra/bifrost.config.json.
 */
export const PLATFORM_ROUTED_MODELS = ["gpt-6.2-astra", "gpt-6-luna"];

/**
 * The credit window. Bifrost budgets always reset; 292 years is the longest
 * window it accepts (a longer one overflows its duration type and is
 * refused), so in practice the credit is spent once.
 */
export const PLATFORM_CREDIT_RESET = "292Y";

/** RFC 4122 version 5 (SHA-1, name-based) UUID. */
export function uuidv5(name: string, namespace: string): string {
    const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
    const hash = createHash("sha1")
        .update(ns)
        .update(name, "utf8")
        .digest()
        .subarray(0, 16);
    hash[6] = (hash[6]! & 0x0f) | 0x50;
    hash[8] = (hash[8]! & 0x3f) | 0x80;
    const hex = hash.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function virtualKeyName(userId: string): string {
    return uuidv5(userId, VIRTUAL_KEY_NAMESPACE);
}

export type Budget = {
    id: string;
    max_limit: number;
    reset_duration: string;
    current_usage: number;
};

export type VirtualKeyProviderConfig = {
    id: number;
    provider: string;
    weight: number | null;
    allowed_models: string[] | null;
    allow_all_keys?: boolean;
    keys?: { key_id: string }[] | null;
    budgets?: Budget[] | null;
};

export type VirtualKey = {
    id: string;
    name: string;
    /** The credential ("sk-bf-..."). */
    value: string;
    is_active: boolean;
    provider_configs: VirtualKeyProviderConfig[] | null;
};

/** A provider config as the update endpoint takes it. */
export type ProviderConfigInput = {
    id?: number;
    provider: string;
    weight: number;
    allowed_models: string[];
    key_ids: string[];
    budgets?: { max_limit: number; reset_duration: string }[];
};

export type ProviderKey = {
    id: string;
    name: string;
    models: string[];
    /** "success", or what went wrong when Bifrost last listed models with it. */
    status?: string;
    description?: string;
};

export type GatewayModel = {
    name: string;
    provider: string;
    accessible_by_keys?: string[] | null;
};

const TIMEOUT_MS = 20_000;

export function gatewayUrl(): string {
    const url = process.env.BIFROST_URL?.trim().replace(/\/+$/, "");
    if (!url) throw new GatewayError("BIFROST_URL is not set.");
    return url;
}

function authHeader(): string {
    const user = process.env.BIFROST_ADMIN_USERNAME ?? "";
    const pass = process.env.BIFROST_ADMIN_PASSWORD ?? "";
    if (!user || !pass) {
        throw new GatewayError(
            "BIFROST_ADMIN_USERNAME and BIFROST_ADMIN_PASSWORD must be set.",
        );
    }
    return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** Bifrost's own words about an error, without anything else in the body. */
function errorMessage(body: unknown): string {
    if (!body || typeof body !== "object") return "";
    const error = (body as { error?: unknown }).error;
    const message =
        typeof error === "string" ? error
        : error && typeof error === "object" ?
            (error as { message?: unknown }).message
        :   (body as { message?: unknown }).message;
    return typeof message === "string" ? message.slice(0, 400) : "";
}

async function call<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${gatewayUrl()}${path}`, {
            method,
            headers: {
                Authorization: authHeader(),
                ...(body === undefined ?
                    {}
                :   { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError("The model gateway could not be reached.");
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new GatewayError(
            errorMessage(json) ||
                `The model gateway answered ${response.status}.`,
            response.status,
        );
    }
    return json as T;
}

// ---------------------------------------------------------------------------
// Virtual keys
// ---------------------------------------------------------------------------

export async function findVirtualKeyByName(
    name: string,
): Promise<VirtualKey | null> {
    // search is a case-insensitive substring match; the name is matched exactly here.
    const data = await call<{ virtual_keys: VirtualKey[] | null }>(
        "GET",
        `/api/governance/virtual-keys?search=${encodeURIComponent(name)}&limit=100`,
    );
    return (data.virtual_keys ?? []).find(k => k.name === name) ?? null;
}

export async function getVirtualKey(id: string): Promise<VirtualKey> {
    const data = await call<{ virtual_key: VirtualKey }>(
        "GET",
        `/api/governance/virtual-keys/${encodeURIComponent(id)}`,
    );
    return data.virtual_key;
}

/**
 * Creates an account's virtual key: the `wts` provider only, the platform
 * credit as that provider config's budget. Answers null when a key by that
 * name already exists (another request created it first).
 */
export async function createVirtualKey(
    name: string,
    creditUsd: number,
): Promise<VirtualKey | null> {
    try {
        const data = await call<{ virtual_key: VirtualKey }>(
            "POST",
            "/api/governance/virtual-keys",
            {
                name,
                description: "WatchThatSite account",
                is_active: true,
                provider_configs: [
                    {
                        provider: PLATFORM_PROVIDER,
                        weight: 1,
                        allowed_models: PLATFORM_ROUTED_MODELS,
                        key_ids: ["*"],
                        budgets: [
                            {
                                max_limit: creditUsd,
                                reset_duration: PLATFORM_CREDIT_RESET,
                            },
                        ],
                    },
                ],
            },
        );
        return data.virtual_key;
    } catch (error) {
        if (error instanceof GatewayError && error.status === 409) return null;
        throw error;
    }
}

/**
 * Replaces a virtual key's provider configs. A config sent with its `id` and
 * without `budgets` keeps its budgets and what was spent against them.
 */
export async function setProviderConfigs(
    id: string,
    configs: ProviderConfigInput[],
): Promise<VirtualKey> {
    const data = await call<{ virtual_key: VirtualKey }>(
        "PUT",
        `/api/governance/virtual-keys/${encodeURIComponent(id)}`,
        { provider_configs: configs },
    );
    return data.virtual_key;
}

export async function deleteVirtualKey(id: string): Promise<void> {
    await call(
        "DELETE",
        `/api/governance/virtual-keys/${encodeURIComponent(id)}`,
    );
}

/** The configs as they are now, in the shape the update endpoint takes. */
export function toConfigInputs(vk: VirtualKey): ProviderConfigInput[] {
    return (vk.provider_configs ?? []).map(config => ({
        id: config.id,
        provider: config.provider,
        weight: config.weight ?? 1,
        allowed_models: config.allowed_models ?? [],
        key_ids:
            config.allow_all_keys ?
                ["*"]
            :   (config.keys ?? []).map(k => k.key_id),
    }));
}

// ---------------------------------------------------------------------------
// Providers and provider keys
// ---------------------------------------------------------------------------

/** Adds a built-in provider (`openai`, `anthropic`) with no keys, unless it exists. */
export async function ensureProvider(provider: string): Promise<void> {
    try {
        await call("GET", `/api/providers/${encodeURIComponent(provider)}`);
        return;
    } catch (error) {
        if (!(error instanceof GatewayError) || error.status !== 404) {
            throw error;
        }
    }
    try {
        await call("POST", "/api/providers", { provider, keys: [] });
    } catch (error) {
        // Created by a request running alongside this one.
        if (error instanceof GatewayError && error.status === 409) return;
        throw error;
    }
}

/**
 * Creates a custom provider for one connection at the base URL its owner
 * entered, then adds the connection's key to it (Bifrost ignores keys sent
 * with the provider).
 *
 * An OpenAI-compatible base URL means what it means to the OpenAI SDK: the
 * address before `/chat/completions` and `/models`, so the paths are set
 * relative to it. Only Chat Completions and model listing are allowed, which
 * also keeps Bifrost from switching the request to the Responses API that
 * most compatible servers do not have. An Anthropic-compatible base URL is
 * the address before `/v1/messages`, which is Bifrost's own convention.
 */
export async function createCustomProvider(opts: {
    name: string;
    base: "openai" | "anthropic";
    baseUrl: string;
    keyName: string;
    apiKey: string;
}): Promise<ProviderKey> {
    const custom =
        opts.base === "openai" ?
            {
                base_provider_type: "openai",
                allowed_requests: {
                    list_models: true,
                    chat_completion: true,
                    chat_completion_stream: true,
                },
                request_path_overrides: {
                    list_models: "/models",
                    chat_completion: "/chat/completions",
                    chat_completion_stream: "/chat/completions",
                },
            }
        :   { base_provider_type: "anthropic" };
    await call("POST", "/api/providers", {
        provider: opts.name,
        keys: [],
        network_config: { base_url: opts.baseUrl },
        custom_provider_config: custom,
    });
    try {
        return await createKey(opts.name, {
            name: opts.keyName,
            value: opts.apiKey,
            models: ["*"],
            weight: 1,
        });
    } catch (error) {
        await deleteProvider(opts.name).catch(() => undefined);
        throw error;
    }
}

export async function deleteProvider(provider: string): Promise<void> {
    try {
        await call("DELETE", `/api/providers/${encodeURIComponent(provider)}`);
    } catch (error) {
        if (error instanceof GatewayError && error.status === 404) return;
        throw error;
    }
}

/**
 * A provider key as Bifrost takes it: the key itself in `value` (empty for a
 * provider whose credentials sit in its config), `aliases` mapping model
 * names to deployments, and the provider's `<provider>_key_config`.
 */
export type KeyBody = {
    name: string;
    value: string;
    models: string[];
    weight: number;
    aliases?: Record<string, string>;
    [config: `${string}_key_config`]: Record<string, unknown>;
};

/** Adds a key to a provider. Bifrost lists models with it straight away. */
export async function createKey(
    provider: string,
    body: KeyBody,
): Promise<ProviderKey> {
    return call<ProviderKey>(
        "POST",
        `/api/providers/${encodeURIComponent(provider)}/keys`,
        body,
    );
}

/** Replaces a key's credentials and settings in place, keeping its id. */
export async function replaceKey(
    provider: string,
    keyId: string,
    body: KeyBody,
): Promise<ProviderKey> {
    return call<ProviderKey>(
        "PUT",
        `/api/providers/${encodeURIComponent(provider)}/keys/${encodeURIComponent(keyId)}`,
        body,
    );
}

export async function deleteKey(
    provider: string,
    keyId: string,
): Promise<void> {
    try {
        await call(
            "DELETE",
            `/api/providers/${encodeURIComponent(provider)}/keys/${encodeURIComponent(keyId)}`,
        );
    } catch (error) {
        if (error instanceof GatewayError && error.status === 404) return;
        throw error;
    }
}

/** Every key of a provider, with the status Bifrost last recorded for it. */
export async function listKeys(provider: string): Promise<ProviderKey[]> {
    const data = await call<{ keys: ProviderKey[] | null }>(
        "GET",
        `/api/providers/${encodeURIComponent(provider)}/keys`,
    );
    return data.keys ?? [];
}

/** The model names (without the provider) one key can use, as Bifrost last listed them. */
export async function keyModels(
    provider: string,
    keyId: string,
): Promise<string[]> {
    const query = new URLSearchParams({
        provider,
        keys: keyId,
        limit: "1000",
    });
    const data = await call<{ models: GatewayModel[] | null }>(
        "GET",
        `/api/models?${query}`,
    );
    return (data.models ?? [])
        .filter(
            m => !m.accessible_by_keys || m.accessible_by_keys.includes(keyId),
        )
        .map(m => m.name);
}
