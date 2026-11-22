import "server-only";

import {
    createCustomProvider,
    createKey,
    createVirtualKey,
    deleteKey,
    deleteProvider,
    ensureProvider,
    findVirtualKeyByName,
    GatewayError,
    getVirtualKey,
    keyModels,
    listKeys,
    PLATFORM_PROVIDER,
    replaceKey,
    setProviderConfigs,
    toConfigInputs,
    virtualKeyName,
    type KeyBody,
    type ProviderKey,
    type VirtualKey,
} from "@/lib/bifrost";
import { auth } from "@watchthatsite/auth/server";
import { sql } from "@watchthatsite/db/pool";
import { getSecret, putSecret, secretHint } from "@watchthatsite/db/vault";
import {
    DEFAULT_PLATFORM_MODEL,
    PLATFORM_CREDIT_USD,
    PLATFORM_MODELS,
    type ConnectionStatus,
    type EndpointKind,
    type PlatformCredit,
    type ProviderConnection,
    type ProviderKind,
} from "@watchthatsite/types";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentModels } from "./datasheet";
import {
    chatModels,
    normalizeBaseUrl,
    pickDefaultModel,
    scrubKey,
} from "./discovery";
import { EndpointError, vetUrl } from "./net";
import { providerSpec } from "./providers";

/**
 * Model connections: the models the Agent can use for an owner's Monitors.
 *
 * Every model call goes through our Bifrost gateway, and each account has one
 * Bifrost virtual key, the only credential the Agent sends. The key may reach
 * the `wts` provider (the platform credit, whose budget is the credit) and,
 * for each connection the owner adds, that connection's own provider key and
 * nothing else. API keys the owner types are handed to Bifrost and stored
 * only there; we keep the last four characters for display.
 *
 * Connections belong to the signed-in user. The platform-credit connection
 * (`managed`) is created by the server and cannot be changed or deleted.
 */

/** An error whose message is meant for the person making the request. */
export class ConnectionError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "ConnectionError";
        this.status = status;
    }
}

export const PLATFORM_CONNECTION_NAME = "WatchThatSite credit";

export const CREDIT_USED_UP =
    "Your WatchThatSite credit is used up. Add your own model connection to keep checking pages.";

const GATEWAY_DOWN =
    "The model gateway is not answering right now. Try again in a moment.";

/** The signed-in user's id, or `null` when nobody is signed in. */
export async function getUserId(): Promise<string | null> {
    const data = await auth.api.getSession({ headers: await headers() });
    return data?.user?.id ?? null;
}

type Row = {
    id: string;
    userId: string;
    kind: ProviderKind;
    name: string;
    baseUrl: string | null;
    settings: Record<string, unknown>;
    gatewayProvider: string;
    gatewayKeyId: string | null;
    apiKeyHint: string;
    models: string[];
    defaultModel: string | null;
    managed: boolean;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
};

/** The row as the browser may see it (no gateway key id), with its key's status. */
function toConnection(
    row: Row,
    status: ConnectionStatus | null,
): ProviderConnection {
    return {
        id: row.id,
        user_id: row.userId,
        kind: row.kind,
        name: row.name,
        base_url: row.baseUrl,
        settings:
            row.settings && typeof row.settings === "object" ?
                row.settings
            :   {},
        gateway_provider: row.gatewayProvider,
        api_key_hint: row.apiKeyHint,
        models: Array.isArray(row.models) ? row.models : [],
        default_model: row.defaultModel,
        managed: row.managed,
        enabled: row.enabled,
        status,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
    };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadRow(userId: string, id: string): Promise<Row> {
    const rows =
        UUID.test(id) ?
            await sql<Row[]>`
                SELECT * FROM provider_connections
                WHERE id = ${id} AND user_id = ${userId}
            `
        :   [];
    const row = rows[0];
    if (!row) throw new ConnectionError(404, "Connection not found.");
    return row;
}

function refuseManaged(row: Row, action: string) {
    if (row.managed) {
        throw new ConnectionError(
            403,
            `The WatchThatSite credit connection cannot be ${action}.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Gateway names
// ---------------------------------------------------------------------------

/**
 * The Bifrost provider a connection's models live under: the built-in one
 * for a public endpoint, otherwise a custom provider of its own, named from
 * the connection id (short, stable, and valid before the `/` of a model
 * string).
 */
function gatewayProviderFor(
    id: string,
    kind: string,
    baseUrl: string | null,
): string {
    return baseUrl ? `c-${id.replace(/-/g, "").slice(0, 16)}` : kind;
}

/** `openai/gpt-6.1-sol` from `openai` and `gpt-6.1-sol`. */
function modelString(provider: string, model: string): string {
    return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function bareModel(provider: string, model: string): string {
    return model.startsWith(`${provider}/`) ?
            model.slice(provider.length + 1)
        :   model;
}

// ---------------------------------------------------------------------------
// The account's virtual key
// ---------------------------------------------------------------------------

type Account = { bifrostId: string; value: string };

async function readAccount(userId: string): Promise<Account | null> {
    const rows = await sql<{ bifrostId: string; secretId: string }[]>`
        SELECT bifrost_id, secret_id FROM virtual_keys WHERE user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
        bifrostId: row.bifrostId,
        value: await getSecret(row.secretId, "virtual_key"),
    };
}

/**
 * The account's virtual key: found by its name in Bifrost, or created there
 * with the platform credit as its `wts` budget, and recorded here. Safe to
 * run concurrently: Bifrost refuses a second key by the same name, and the
 * table keeps one row per user.
 */
async function ensureAccount(userId: string): Promise<Account> {
    const known = await readAccount(userId);
    if (known) return known;

    const name = virtualKeyName(userId);
    let vk: VirtualKey | null =
        (await findVirtualKeyByName(name)) ??
        (await createVirtualKey(name, PLATFORM_CREDIT_USD));
    vk ??= await findVirtualKeyByName(name);
    if (!vk) throw new GatewayError("The virtual key could not be created.");
    const found = vk;

    await sql
        .begin(async tx => {
            const secretId = await putSecret(
                { userId },
                "virtual_key",
                found.value,
                tx,
            );
            const inserted = await tx`
                INSERT INTO virtual_keys (user_id, bifrost_id, bifrost_name, secret_id)
                VALUES (${userId}, ${found.id}, ${found.name}, ${secretId})
                ON CONFLICT (user_id) DO NOTHING
                RETURNING user_id
            `;
            // Recorded by a request running alongside this one: drop the
            // secret written here along with the transaction.
            if (inserted.length === 0) throw new AlreadyRecorded();
        })
        .catch(error => {
            if (!(error instanceof AlreadyRecorded)) throw error;
        });
    return (await readAccount(userId))!;
}

class AlreadyRecorded extends Error {}

/** A query function: the pool, or a transaction on it. */
type Db = typeof sql;

const ensuring = new Map<string, Promise<void>>();

/**
 * Makes sure the account has its virtual key and its platform-credit
 * connection. Cheap once both exist (one query). Throws GatewayError when
 * Bifrost cannot be reached; callers carry on without it and the next call
 * tries again.
 */
export function ensurePlatformConnection(userId: string): Promise<void> {
    let running = ensuring.get(userId);
    if (!running) {
        running = provisionPlatform(userId).finally(() =>
            ensuring.delete(userId),
        );
        ensuring.set(userId, running);
    }
    return running;
}

async function provisionPlatform(userId: string): Promise<void> {
    const existing = await sql`
        SELECT 1 FROM provider_connections WHERE user_id = ${userId} AND managed
    `;
    if (existing.length > 0) return;
    await ensureAccount(userId);
    await sql`
        INSERT INTO provider_connections
            (user_id, kind, name, base_url, gateway_provider, gateway_key_id,
             models, default_model, managed)
        VALUES
            (${userId}, ${PLATFORM_PROVIDER}, ${PLATFORM_CONNECTION_NAME}, NULL, ${PLATFORM_PROVIDER},
             NULL, ${sql.json([...PLATFORM_MODELS])}, ${DEFAULT_PLATFORM_MODEL},
             TRUE)
        ON CONFLICT (user_id) WHERE managed DO NOTHING
    `;
}

/**
 * Changes the account's virtual key while no other request of the same user
 * does: its provider configs are read, changed and written back whole.
 */
async function withAccountLock<T>(
    userId: string,
    run: (account: Account, tx: Db) => Promise<T>,
): Promise<T> {
    const account = await ensureAccount(userId);
    return sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`virtual_key:${userId}`}))`;
        return run(account, tx as unknown as Db);
    }) as Promise<T>;
}

/** Lets the virtual key use `keyId` on `provider`, and nothing more of it. */
async function attachKey(account: Account, provider: string, keyId: string) {
    const configs = toConfigInputs(await getVirtualKey(account.bifrostId));
    const config = configs.find(c => c.provider === provider);
    if (config) {
        config.key_ids = [
            ...new Set([...config.key_ids.filter(k => k !== "*"), keyId]),
        ];
    } else {
        configs.push({
            provider,
            weight: 1,
            allowed_models: ["*"],
            key_ids: [keyId],
        });
    }
    await setProviderConfigs(account.bifrostId, configs);
}

async function detachKey(account: Account, provider: string, keyId: string) {
    const configs = toConfigInputs(await getVirtualKey(account.bifrostId));
    const next = configs
        .map(c =>
            c.provider === provider ?
                { ...c, key_ids: c.key_ids.filter(k => k !== keyId) }
            :   c,
        )
        .filter(c => c.provider !== provider || c.key_ids.length > 0);
    await setProviderConfigs(account.bifrostId, next);
}

// ---------------------------------------------------------------------------
// Platform credit
// ---------------------------------------------------------------------------

const CREDIT_TTL_MS = 30_000;
const holder = globalThis as {
    __platformCredit?: Map<
        string,
        { at: number; credit: Omit<PlatformCredit, "connection_id"> }
    >;
};
const creditCache = (holder.__platformCredit ??= new Map());

/** What is left of the credit, read from the virtual key's `wts` budget. */
async function readCredit(
    userId: string,
): Promise<Omit<PlatformCredit, "connection_id"> | null> {
    const cached = creditCache.get(userId);
    if (cached && Date.now() - cached.at < CREDIT_TTL_MS) {
        return cached.credit;
    }
    const account = await readAccount(userId);
    if (!account) return null;
    const vk = await getVirtualKey(account.bifrostId);
    const budget = (vk.provider_configs ?? []).find(
        c => c.provider === PLATFORM_PROVIDER,
    )?.budgets?.[0];
    if (!budget) return null;
    const limit = budget.max_limit;
    const used = Math.max(0, budget.current_usage);
    const credit = {
        limit_usd: limit,
        used_usd: used,
        left_usd: Math.max(0, limit - used),
    };
    creditCache.set(userId, { at: Date.now(), credit });
    return credit;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const kind = z
    .string({ error: "Choose a provider." })
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Choose a provider.");
const name = z
    .string({ error: "Give the connection a name." })
    .trim()
    .min(1, "Give the connection a name.")
    .max(100, "Keep the name under 100 characters.");
const apiKey = z
    .string({ error: "The API key must be text." })
    .trim()
    .max(4000, "That key is too long.")
    .optional();
const baseUrl = z
    .string({ error: "The base URL must be text." })
    .trim()
    .max(500, "That base URL is too long.")
    .nullable()
    .optional();
/** The provider's own fields (see providers.ts), secret or not. */
const fields = z
    .record(
        z.string().max(60),
        z.string().max(20_000, "One of the fields is too long."),
    )
    .optional();
/** Model name → Azure deployment or Bedrock inference profile. */
const deployments = z
    .record(
        z.string().trim().min(1).max(200),
        z.string().trim().min(1).max(500),
    )
    .optional();
const modelId = z
    .string({ error: "A model id must be text." })
    .trim()
    .min(1, "A model id cannot be empty.")
    .max(250, "A model id can be at most 250 characters.");

export const createSchema = z
    .object({ kind, name, baseUrl, apiKey, fields, deployments })
    .strict();

export const updateSchema = z
    .object({
        name: name.optional(),
        baseUrl,
        apiKey,
        fields,
        deployments,
        models: z.array(modelId).max(500).optional(),
        defaultModel: modelId.nullable().optional(),
        enabled: z.boolean().optional(),
    })
    .strict();

/** Parses a request body, turning the first problem into a 400. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (result.success) return result.data;
    throw new ConnectionError(
        400,
        result.error.issues[0]?.message ?? "The request is not valid.",
    );
}

/** Refuses an address the gateway must not be told to call. */
async function vetted(url: string): Promise<string> {
    try {
        await vetUrl(url);
    } catch (error) {
        if (error instanceof EndpointError) {
            throw new ConnectionError(400, error.message);
        }
        throw error;
    }
    return url;
}

/** Normalizes a custom endpoint's URL and refuses one the gateway must not call. */
async function checkedBaseUrl(
    endpoint: EndpointKind,
    raw: string | null | undefined,
): Promise<string | null> {
    const normalized = normalizeBaseUrl(endpoint, raw);
    return normalized === null ? null : vetted(normalized);
}

// ---------------------------------------------------------------------------
// From the form to a gateway key
// ---------------------------------------------------------------------------

/** What a connection's credentials become in Bifrost, and what we keep. */
type Credentials = {
    kind: string;
    /** A custom endpoint's URL, or null for a provider of Bifrost's own. */
    baseUrl: string | null;
    /** Everything but the key's name. */
    body: Omit<KeyBody, "name">;
    /** The non-secret settings, kept on the connection for display. */
    settings: Record<string, unknown>;
    hint: string;
    /** The secret strings, to scrub out of anything the provider says. */
    secrets: string[];
};

function isEndpointKind(value: string): value is EndpointKind {
    return value === "openai" || value === "anthropic";
}

/**
 * Checks what the form sent against the provider's fields and builds the
 * Bifrost key: the API key in `value`, deployments in `aliases`, the rest in
 * the provider's `<provider>_key_config`. URLs are vetted like a base URL.
 */
async function credentialsFor(input: {
    kind: string;
    baseUrl?: string | null | undefined;
    apiKey?: string | undefined;
    fields?: Record<string, string> | undefined;
    deployments?: Record<string, string> | undefined;
}): Promise<Credentials> {
    const key = input.apiKey?.trim() ?? "";
    const typedUrl = input.baseUrl?.trim();

    // A custom endpoint: any server that speaks one of the two APIs.
    if (typedUrl) {
        if (!isEndpointKind(input.kind)) {
            throw new ConnectionError(
                400,
                "A base URL is only for an OpenAI- or Anthropic-compatible endpoint.",
            );
        }
        const base = await checkedBaseUrl(input.kind, typedUrl);
        if (!key) throw new ConnectionError(400, "Enter the API key.");
        return {
            kind: input.kind,
            baseUrl: base,
            body: { value: key, models: ["*"], weight: 1 },
            settings: {},
            hint: secretHint(key),
            secrets: [key],
        };
    }

    const spec = providerSpec(input.kind);
    if (!spec) throw new ConnectionError(400, "Choose a provider.");
    const typed = input.fields ?? {};
    const config: Record<string, unknown> = {};
    const settings: Record<string, unknown> = {};
    const secrets = key ? [key] : [];

    for (const field of spec.fields) {
        const value = typed[field.name]?.trim() ?? "";
        if (!value) {
            if (field.required) {
                throw new ConnectionError(400, `Enter the ${field.label}.`);
            }
            continue;
        }
        if (field.kind === "url") await vetted(value.replace(/\/+$/, ""));
        if (field.kind === "json") {
            let parsed: unknown;
            try {
                parsed = JSON.parse(value);
            } catch {
                throw new ConnectionError(
                    400,
                    `The ${field.label} is not valid JSON.`,
                );
            }
            // Other credential types name URLs the gateway would call, or
            // run on the gateway's own identity.
            if ((parsed as { type?: unknown })?.type !== "service_account") {
                throw new ConnectionError(
                    400,
                    `The ${field.label} must be a service account key ("type": "service_account").`,
                );
            }
        }
        config[field.name] =
            field.kind === "url" ? value.replace(/\/+$/, "") : value;
        if (field.kind === "secret" || field.kind === "json") {
            secrets.push(value);
        } else {
            settings[field.name] = config[field.name];
        }
    }

    if (spec.key?.required && !key) {
        throw new ConnectionError(400, `Enter the ${spec.key.label}.`);
    }
    if (
        spec.id === "bedrock" &&
        !key &&
        !(config.access_key && config.secret_key)
    ) {
        throw new ConnectionError(
            400,
            "Enter a Bedrock API key, or an access key ID and secret access key.",
        );
    }

    const aliases =
        spec.deployments && input.deployments ?
            Object.fromEntries(
                Object.entries(input.deployments).filter(
                    ([model, target]) => model.trim() && target.trim(),
                ),
            )
        :   {};
    if (Object.keys(aliases).length > 0) settings.deployments = aliases;

    const body: Omit<KeyBody, "name"> = {
        value: key,
        models: ["*"],
        weight: 1,
        ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    };
    if (spec.config && Object.keys(config).length > 0) {
        body[spec.config as `${string}_key_config`] = config;
    }

    const accessKey =
        typeof config.access_key === "string" ? config.access_key : "";
    const serviceAccount =
        typeof config.auth_credentials === "string" ?
            (JSON.parse(config.auth_credentials) as {
                private_key_id?: unknown;
            })
        :   null;
    const hint =
        key ? secretHint(key)
        : accessKey ? secretHint(accessKey)
        : typeof serviceAccount?.private_key_id === "string" ?
            secretHint(serviceAccount.private_key_id)
        :   "";
    return {
        kind: spec.id,
        baseUrl: null,
        body,
        settings,
        hint,
        secrets,
    };
}

function scrubAll(text: string, secrets: string[]): string {
    return secrets.reduce((out, secret) => scrubKey(out, secret), text);
}

// ---------------------------------------------------------------------------
// Provider keys in the gateway
// ---------------------------------------------------------------------------

type Provisioned = { provider: string; key: ProviderKey; custom: boolean };

/**
 * Puts credentials into Bifrost: a key on the provider itself, or for a
 * custom endpoint a custom provider at its URL holding the key. Bifrost
 * lists models with a new key straight away and keeps the result as the
 * key's status.
 */
async function provision(
    provider: string,
    keyName: string,
    credentials: Credentials,
): Promise<Provisioned> {
    if (credentials.baseUrl) {
        const key = await createCustomProvider({
            name: provider,
            base: credentials.kind as EndpointKind,
            baseUrl: credentials.baseUrl,
            keyName,
            apiKey: credentials.body.value,
        });
        return { provider, key, custom: true };
    }
    await ensureProvider(provider);
    const key = await createKey(provider, {
        name: keyName,
        ...credentials.body,
    });
    return { provider, key, custom: false };
}

/** Removes what `provision` made. */
async function unprovision(p: {
    provider: string;
    keyId: string;
    custom: boolean;
}): Promise<void> {
    if (p.custom) await deleteProvider(p.provider);
    else await deleteKey(p.provider, p.keyId);
}

function isCustomProvider(provider: string): boolean {
    return provider.startsWith("c-");
}

/**
 * A key's status as Bifrost keeps it: it lists models with every key when
 * the key is added or changed, and again in the background, and records
 * whether that worked. Bifrost keeps no time for it.
 */
function statusOf(key: ProviderKey, secrets: string[] = []): ConnectionStatus {
    if (!key.status) return { state: "unknown", error: null };
    if (key.status === "success") return { state: "working", error: null };
    const said = scrubAll(key.description?.trim() ?? "", secrets).slice(0, 400);
    return {
        state: "failing",
        error:
            said || "The provider refused the key. Check it and the settings.",
    };
}

/** The models a key can use, as gateway model strings, sorted. */
/**
 * The models a key can reach that the Agent can use: the provider's own
 * listing through the gateway, narrowed with Bifrost's datasheets to models
 * that converse, call tools and read images. Deployment names (Azure,
 * Bedrock inference profiles) are the owner's own and always kept.
 */
async function listedModels(
    kind: string,
    provider: string,
    keyId: string,
    deployments: string[],
): Promise<string[]> {
    const listed = await agentModels(
        kind,
        (await keyModels(provider, keyId)).map(m => bareModel(provider, m)),
    );
    return [...new Set([...deployments, ...listed])]
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
        .map(model => modelString(provider, model));
}

function deploymentModels(settings: Record<string, unknown>): string[] {
    return settings.deployments && typeof settings.deployments === "object" ?
            Object.keys(settings.deployments)
        :   [];
}

/** Enabled models and a default for a new connection, from what its key lists. */
function initialModels(kindOf: string, provider: string, listed: string[]) {
    const bare = chatModels(listed.map(m => bareModel(provider, m)));
    const picked = pickDefaultModel(kindOf, bare);
    return {
        models: bare.map(m => modelString(provider, m)),
        defaultModel: picked ? modelString(provider, picked) : null,
    };
}

function gatewayFailure(error: unknown): never {
    if (error instanceof GatewayError) {
        console.error("[connections] gateway call failed:", error.message);
        // Bifrost's own 400s are about what was typed (a region it does not
        // know, a malformed setting, an address it will not call): say them.
        if (error.status === 400) {
            throw new ConnectionError(
                400,
                `The model gateway did not accept these settings: ${error.message}`,
            );
        }
        throw new ConnectionError(502, GATEWAY_DOWN);
    }
    throw error;
}

// ---------------------------------------------------------------------------
// Key status, read from the gateway
// ---------------------------------------------------------------------------

const STATUS_TTL_MS = 30_000;
const statusHolder = globalThis as {
    __connectionStatus?: Map<
        string,
        { at: number; byKey: Map<string, ConnectionStatus> }
    >;
};
const statusCache = (statusHolder.__connectionStatus ??= new Map());

/** Each of the user's gateway keys and its status, cached briefly. */
async function keyStatuses(
    userId: string,
    rows: Row[],
): Promise<Map<string, ConnectionStatus>> {
    const cached = statusCache.get(userId);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.byKey;
    const byKey = new Map<string, ConnectionStatus>();
    const providers = [
        ...new Set(
            rows.filter(r => r.gatewayKeyId).map(r => r.gatewayProvider),
        ),
    ];
    // A built-in provider's listing holds every account's keys; only this
    // user's are kept.
    const wanted = new Set(rows.map(r => r.gatewayKeyId));
    await Promise.all(
        providers.map(async provider => {
            for (const key of await listKeys(provider)) {
                if (wanted.has(key.id)) byKey.set(key.id, statusOf(key));
            }
        }),
    );
    statusCache.set(userId, { at: Date.now(), byKey });
    return byKey;
}

function forgetStatuses(userId: string) {
    statusCache.delete(userId);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** An account holds a handful of connections; this only stops a runaway client. */
const MAX_CONNECTIONS = 25;

/**
 * The user's connections, the platform credit first, then enabled ones, then
 * oldest first, each with its key's status from the gateway (null when the
 * gateway cannot say). The Connections page shows only the owner's own; the
 * Monitor form offers every one of them.
 */
export async function listConnections(
    userId: string,
): Promise<ProviderConnection[]> {
    const rows = await sql<Row[]>`
        SELECT * FROM provider_connections
        WHERE user_id = ${userId}
        ORDER BY managed DESC, enabled DESC, created_at ASC
    `;
    let statuses: Map<string, ConnectionStatus> | null = null;
    try {
        statuses = await keyStatuses(userId, rows);
    } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        console.error(
            "[connections] could not read key status:",
            error.message,
        );
    }
    return rows.map(row =>
        toConnection(
            row,
            row.gatewayKeyId && statuses ?
                (statuses.get(row.gatewayKeyId) ?? {
                    state: "unknown",
                    error: null,
                })
            :   null,
        ),
    );
}

/**
 * What is left of the account's platform credit, read from the gateway and
 * cached for 30 seconds. `null` when the account has no credit yet or the
 * gateway cannot say. Used by the Usage page and the app's low-credit note.
 */
export async function getPlatformCredit(
    userId: string,
): Promise<PlatformCredit | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM provider_connections WHERE user_id = ${userId} AND managed
    `;
    if (!rows[0]) return null;
    try {
        const credit = await readCredit(userId);
        return credit ? { connection_id: rows[0].id, ...credit } : null;
    } catch (error) {
        if (error instanceof GatewayError) return null;
        throw error;
    }
}

/**
 * Adds a connection: the credentials go into Bifrost (on a custom provider
 * for a custom endpoint) and are attached to the account's virtual key.
 * Bifrost checks the key itself when it is added; its verdict is the
 * connection's status, and the models it listed are enabled. If Bifrost
 * refuses the key outright, nothing is left behind.
 */
export async function createConnection(
    userId: string,
    input: z.infer<typeof createSchema>,
): Promise<ProviderConnection> {
    const credentials = await credentialsFor(input);

    const [{ count }] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::INT AS count FROM provider_connections
        WHERE user_id = ${userId} AND NOT managed
    `;
    if (count >= MAX_CONNECTIONS) {
        throw new ConnectionError(
            409,
            `You already have ${MAX_CONNECTIONS} connections. Delete one before adding another.`,
        );
    }

    const id = randomUUID();
    const provider = gatewayProviderFor(
        id,
        credentials.kind,
        credentials.baseUrl,
    );
    try {
        return await withAccountLock(userId, async (account, tx) => {
            const p = await provision(provider, id, credentials);
            const undo = () =>
                unprovision({ ...p, keyId: p.key.id }).catch(() => undefined);
            try {
                const status = statusOf(p.key, credentials.secrets);
                const listed =
                    status.state === "failing" ?
                        deploymentModels(credentials.settings).map(m =>
                            modelString(p.provider, m),
                        )
                    :   await listedModels(
                            credentials.kind,
                            p.provider,
                            p.key.id,
                            deploymentModels(credentials.settings),
                        );
                const { models, defaultModel } = initialModels(
                    credentials.kind,
                    p.provider,
                    listed,
                );
                await attachKey(account, p.provider, p.key.id);
                try {
                    const rows = await tx<Row[]>`
                        INSERT INTO provider_connections
                            (id, user_id, kind, name, base_url, settings,
                             gateway_provider, gateway_key_id, api_key_hint,
                             models, default_model)
                        VALUES
                            (${id}, ${userId}, ${credentials.kind}, ${input.name},
                             ${credentials.baseUrl}, ${tx.json(credentials.settings as never)},
                             ${p.provider}, ${p.key.id}, ${credentials.hint},
                             ${tx.json(models)}, ${defaultModel})
                        RETURNING *
                    `;
                    forgetStatuses(userId);
                    return toConnection(rows[0]!, status);
                } catch (error) {
                    await detachKey(account, p.provider, p.key.id).catch(
                        () => undefined,
                    );
                    throw error;
                }
            } catch (error) {
                await undo();
                throw error;
            }
        });
    } catch (error) {
        return gatewayFailure(error);
    }
}

export async function updateConnection(
    userId: string,
    id: string,
    input: z.infer<typeof updateSchema>,
): Promise<ProviderConnection> {
    const row = await loadRow(userId, id);
    refuseManaged(row, "changed");

    const nextBase =
        input.baseUrl === undefined ? row.baseUrl
        : isEndpointKind(row.kind) ? normalizeBaseUrl(row.kind, input.baseUrl)
        : null;
    if (row.baseUrl && !nextBase) {
        throw new ConnectionError(
            400,
            "A custom endpoint needs its base URL. To use the provider's own endpoint, add a new connection.",
        );
    }
    if (!row.baseUrl && nextBase) {
        throw new ConnectionError(
            400,
            "Add a new connection for a custom endpoint.",
        );
    }
    const baseChanged = nextBase !== row.baseUrl;
    // Credentials are only ever sent where their owner first sent them, and
    // a stored secret cannot be read back: any change to how the provider is
    // reached needs the secrets typed again.
    const credentialsChanged =
        baseChanged ||
        Boolean(input.apiKey) ||
        input.fields !== undefined ||
        input.deployments !== undefined;

    // Model ids typed without their provider get it, so every id is one the
    // gateway can route.
    const models =
        input.models === undefined ?
            row.models
        :   [
                ...new Set(
                    input.models.map(m => modelString(row.gatewayProvider, m)),
                ),
            ];
    let defaultModel =
        input.defaultModel === undefined ? row.defaultModel
        : input.defaultModel === null ? null
        : modelString(row.gatewayProvider, input.defaultModel);
    if (input.defaultModel && defaultModel && !models.includes(defaultModel)) {
        throw new ConnectionError(
            400,
            "The default model must be one of the enabled models.",
        );
    }
    // The default was switched off: fall back to the first model left.
    if (defaultModel && !models.includes(defaultModel)) {
        defaultModel = models[0] ?? null;
    }

    let status: ConnectionStatus | null = null;
    if (credentialsChanged) {
        const credentials = await credentialsFor({
            kind: row.kind,
            baseUrl: nextBase,
            apiKey: input.apiKey,
            fields: input.fields,
            deployments: input.deployments,
        });
        try {
            status =
                baseChanged ?
                    await moveConnection(userId, row, credentials)
                :   await replaceCredentials(row, credentials);
        } catch (error) {
            gatewayFailure(error);
        }
        forgetStatuses(userId);
    }

    const current = await loadRow(userId, id);
    const rows = await sql<Row[]>`
        UPDATE provider_connections
        SET name = ${input.name ?? current.name},
            models = ${sql.json(input.models === undefined ? current.models : models)},
            default_model = ${input.models === undefined && input.defaultModel === undefined ? current.defaultModel : defaultModel},
            enabled = ${input.enabled ?? current.enabled}
        WHERE id = ${id}
        RETURNING *
    `;
    return toConnection(rows[0]!, status);
}

/** Replaces the gateway key's credentials and settings in place. */
async function replaceCredentials(
    row: Row,
    credentials: Credentials,
): Promise<ConnectionStatus> {
    const key = await replaceKey(row.gatewayProvider, row.gatewayKeyId!, {
        name: row.id,
        ...credentials.body,
    });
    await sql`
        UPDATE provider_connections
        SET settings = ${sql.json(credentials.settings as never)},
            api_key_hint = ${credentials.hint}
        WHERE id = ${row.id}
    `;
    return statusOf(key, credentials.secrets);
}

/**
 * Moves a custom endpoint to another URL: the old custom provider comes off
 * the virtual key and is removed, and a new one is put in its place under
 * the same name, so the connection's model ids and the Monitors that use
 * them stay as they are.
 */
async function moveConnection(
    userId: string,
    row: Row,
    credentials: Credentials,
): Promise<ConnectionStatus> {
    return withAccountLock(userId, async (account, tx) => {
        await detachKey(account, row.gatewayProvider, row.gatewayKeyId!);
        await unprovision({
            provider: row.gatewayProvider,
            keyId: row.gatewayKeyId!,
            custom: true,
        });
        const p = await provision(row.gatewayProvider, row.id, credentials);
        await attachKey(account, p.provider, p.key.id);
        await tx`
            UPDATE provider_connections
            SET base_url = ${credentials.baseUrl},
                gateway_key_id = ${p.key.id},
                api_key_hint = ${credentials.hint}
            WHERE id = ${row.id}
        `;
        return statusOf(p.key, credentials.secrets);
    });
}

/**
 * Removes a connection, its gateway key (and custom provider), and its
 * provider config on the virtual key. Monitors that used it get
 * connection_id NULL by foreign key and run on the owner's next enabled
 * connection.
 */
export async function deleteConnection(
    userId: string,
    id: string,
): Promise<void> {
    const row = await loadRow(userId, id);
    refuseManaged(row, "deleted");
    try {
        await withAccountLock(userId, async (account, tx) => {
            await detachKey(account, row.gatewayProvider, row.gatewayKeyId!);
            await unprovision({
                provider: row.gatewayProvider,
                keyId: row.gatewayKeyId!,
                custom: isCustomProvider(row.gatewayProvider),
            });
            await tx`DELETE FROM provider_connections WHERE id = ${row.id}`;
        });
    } catch (error) {
        gatewayFailure(error);
    }
    forgetStatuses(userId);
}

/**
 * The models a connection's key can use, as Bifrost last listed them, for
 * the models editor. A key Bifrost cannot list models with answers its
 * error, and the owner types model ids by hand.
 */
export async function connectionModels(
    userId: string,
    id: string,
): Promise<{ models: string[]; error: string | null }> {
    const row = await loadRow(userId, id);
    if (row.managed) return { models: [...PLATFORM_MODELS], error: null };
    try {
        const key = (await listKeys(row.gatewayProvider)).find(
            k => k.id === row.gatewayKeyId,
        );
        if (!key) {
            return {
                models: [],
                error: "This connection's key is missing from the model gateway. Delete the connection and add it again.",
            };
        }
        const status = statusOf(key);
        if (status.state === "failing") {
            return { models: [], error: status.error };
        }
        return {
            models: await listedModels(
                row.kind,
                row.gatewayProvider,
                key.id,
                deploymentModels(row.settings ?? {}),
            ),
            error: null,
        };
    } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        console.error("[connections] gateway call failed:", error.message);
        return { models: [], error: GATEWAY_DOWN };
    }
}

// ---------------------------------------------------------------------------
// Rate limit for gateway changes
// ---------------------------------------------------------------------------

const CHANGES_PER_MINUTE = 12;
const WINDOW_MS = 60_000;

// Kept on globalThis so a dev-server reload does not reset it. One process
// only, which is enough for a limit this light.
const checksHolder = globalThis as {
    __connectionChecks?: Map<string, number[]>;
};
const checks: Map<string, number[]> = (checksHolder.__connectionChecks ??=
    new Map());

/**
 * Counts one change that reaches the provider through the gateway (Bifrost
 * lists models with every new or changed key); throws a 429 past the limit.
 */
export function countCheck(userId: string) {
    const now = Date.now();
    const recent = (checks.get(userId) ?? []).filter(
        at => now - at < WINDOW_MS,
    );
    if (recent.length >= CHANGES_PER_MINUTE) {
        throw new ConnectionError(
            429,
            "Too many changes in a short time. Wait a minute and try again.",
        );
    }
    recent.push(now);
    checks.set(userId, recent);
}
