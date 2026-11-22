/**
 * Database fixtures for the suites that exercise Postgres: a user, a Monitor,
 * and optionally a model connection, secrets, Runs and Macros. Each fixture
 * creates its own rows under a fresh user and removes them again; the schema
 * is never touched.
 */
import { putSecret } from "@watchthatsite/db/vault";
import type {
    MacroStatus,
    MacroStep,
    ProviderKind,
} from "@watchthatsite/types";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { PgStore } from "../store/pg.js";

/** Whether Postgres and the vault key are configured (see vitest.config.ts). */
export const hasDb =
    Boolean(process.env.POSTGRES_HOST || process.env.DATABASE_URL) &&
    Boolean(process.env.ENCRYPTION_KEY);

let shared: Sql | null = null;

/** The service's own client, imported only when a suite needs the database. */
export async function db(): Promise<Sql> {
    if (!shared) {
        shared = (await import("@watchthatsite/db/pool")).sql as unknown as Sql;
    }
    return shared;
}

export async function closeDb(): Promise<void> {
    if (shared) await shared.end({ timeout: 2 }).catch(() => undefined);
    shared = null;
}

export type Fixture = {
    sql: Sql;
    store: PgStore;
    userId: string;
    monitorId: string;
    connectionId: string | null;
    /** Inserts a Run and returns its id. */
    addRun(): Promise<string>;
    addMacro(
        steps: MacroStep[],
        status?: MacroStatus,
        goal?: string,
    ): Promise<string>;
    addSecret(name: string, value: string): Promise<void>;
    cleanup(): Promise<void>;
};

export async function createFixture(opts: {
    url: string;
    name?: string;
    instructions?: string;
    viewport?: { w: number; h: number };
    /**
     * Where the store sends model calls, standing in for the Bifrost gateway
     * (a FakeProvider's `gatewayUrl`). Defaults to an address nothing
     * listens on.
     */
    gatewayUrl?: string;
    /** The account's virtual key, stored in the vault like the real one. */
    virtualKey?: string;
    /** The Monitor's connection, or null for a Monitor without one. */
    connection?: {
        kind: ProviderKind;
        /** The platform credit rather than a key of the owner's own. */
        managed?: boolean;
        model?: string;
        models?: string[];
    } | null;
}): Promise<Fixture> {
    const sql = await db();
    const store = new PgStore(sql, opts.gatewayUrl ?? "http://127.0.0.1:9");
    const userId = `test-bw-${randomUUID()}`;
    const owner = { userId };
    await sql`
        INSERT INTO users (id, name, email, email_verified)
        VALUES (${userId}, 'Browser worker test', ${`${userId}@example.test`}, TRUE)
    `;

    const vkSecret = await putSecret(
        owner,
        "virtual_key",
        opts.virtualKey ?? "sk-bf-test-000000000000",
        sql,
    );
    await sql`
        INSERT INTO virtual_keys (user_id, bifrost_id, bifrost_name, secret_id)
        VALUES (${userId}, ${`vk-${userId}`}, ${`name-${userId}`}, ${vkSecret})
    `;

    let connectionId: string | null = null;
    const c = opts.connection ?? null;
    if (c) {
        const models = c.models ?? (c.model ? [c.model] : []);
        const rows = await sql<{ id: string }[]>`
            INSERT INTO provider_connections
                (user_id, kind, name, gateway_provider, gateway_key_id, managed,
                 models, default_model)
            VALUES (${userId}, ${c.kind}, 'Test connection',
                    ${c.managed ? "wts" : c.kind},
                    ${c.managed ? null : `key-${randomUUID()}`}, ${c.managed ?? false},
                    ${sql.json(models)}, ${c.model ?? null})
            RETURNING id
        `;
        connectionId = rows[0]!.id;
    }

    const viewport = opts.viewport ?? { w: 800, h: 600 };
    const monitors = await sql<{ id: string }[]>`
        INSERT INTO monitors
            (user_id, name, url, instructions, connection_id, model, viewport_w, viewport_h, block_ads)
        VALUES (${userId}, ${opts.name ?? "Test Monitor"}, ${opts.url},
                ${opts.instructions ?? ""}, ${connectionId}, ${c?.model ?? null},
                ${viewport.w}, ${viewport.h}, FALSE)
        RETURNING id
    `;
    const monitorId = monitors[0]!.id;

    return {
        sql,
        store,
        userId,
        monitorId,
        connectionId,
        async addRun() {
            const rows = await sql<{ id: string }[]>`
                INSERT INTO monitor_runs (monitor_id, user_id, status)
                VALUES (${monitorId}, ${userId}, 'processing') RETURNING id
            `;
            return rows[0]!.id;
        },
        async addMacro(steps, status = "active", goal = "Test goal") {
            const rows = await sql<{ id: string }[]>`
                INSERT INTO macros (monitor_id, user_id, version, status, source, goal, steps)
                SELECT ${monitorId}, ${userId}, COALESCE(MAX(version), 0) + 1,
                       ${status}, 'user', ${goal}, ${sql.json(steps as never)}
                FROM macros WHERE monitor_id = ${monitorId}
                RETURNING id
            `;
            return rows[0]!.id;
        },
        async addSecret(name, value) {
            const secretId = await putSecret(owner, "macro_secret", value, sql);
            await sql`
                INSERT INTO monitor_secrets (monitor_id, user_id, name, secret_id)
                VALUES (${monitorId}, ${userId}, ${name}, ${secretId})
            `;
        },
        async cleanup() {
            // Monitors first (their Macros, secrets, Runs and steps cascade),
            // then what points at the vault, then the vault rows themselves.
            await sql`DELETE FROM monitors WHERE user_id = ${userId}`;
            await sql`DELETE FROM provider_connections WHERE user_id = ${userId}`;
            await sql`DELETE FROM virtual_keys WHERE user_id = ${userId}`;
            await sql`DELETE FROM secrets WHERE user_id = ${userId}`;
            await sql`DELETE FROM users WHERE id = ${userId}`;
        },
    };
}

/** Polls until `check` returns something, for work that finishes in the background. */
export async function waitFor<T>(
    check: () => Promise<T | null | undefined | false>,
    timeoutMs = 45_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
