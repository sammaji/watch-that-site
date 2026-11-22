import { Pool, type PoolConfig } from "pg";
import postgres from "postgres";

declare global {
    var __watchThatSitePgPool: Pool | undefined;
}

const sharedConfig: PoolConfig = {
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    maxUses: 7500,
};

function getConnectionString() {
    if (process.env.DATABASE_URL) {
        return process.env.DATABASE_URL;
    }

    const user = process.env.POSTGRES_USER;
    const password = process.env.POSTGRES_PASSWORD;
    const host = process.env.POSTGRES_HOST;
    const port = process.env.POSTGRES_PORT;
    const database = process.env.POSTGRES_DATABASE;

    return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

function createPool() {
    return new Pool({
        connectionString: getConnectionString(),
        ...sharedConfig,
    });
}

export const dbPool = globalThis.__watchThatSitePgPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
    globalThis.__watchThatSitePgPool = dbPool;
}

/**
 * A postgres.js client configured with automatic shallow camelCase <-> snake_case
 * transformation. Column names returned by the DB are converted to camelCase,
 * and insert/update parameter keys are converted back to snake_case.
 *
 * Nested JSONB values are preserved as-is (shallow conversion only).
 *
 * Use this for services that need typed, camelCase results.
 * For raw pg access (e.g. better-auth), use @watchthatsite/db/pool instead.
 */
export const sql = postgres(getConnectionString(), {
    // Column names only. `postgres.camel` would also rewrite the keys inside
    // JSON values, turning a stored Macro step's `timeout_ms` into
    // `timeoutMs` on the way out.
    transform: {
        column: { from: postgres.toCamel, to: postgres.fromCamel },
    },
    idle_timeout: sharedConfig.idleTimeoutMillis as number,
    connect_timeout: sharedConfig.connectionTimeoutMillis as number,
});

export const postgresError = postgres.PostgresError;
