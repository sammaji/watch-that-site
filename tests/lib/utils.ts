import { requiredEnv } from "./env";

export function getDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const database = requiredEnv("POSTGRES_DATABASE");
    const host = requiredEnv("POSTGRES_HOST");
    const port = requiredEnv("POSTGRES_PORT");
    const user = encodeURIComponent(requiredEnv("POSTGRES_USER"));
    const password = requiredEnv("POSTGRES_PASSWORD");
    return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

export function getAmqpUrl() {
    if (process.env.RABBITMQ_URL) return process.env.RABBITMQ_URL;
    const user = encodeURIComponent(requiredEnv("RABBITMQ_USER"));
    const password = encodeURIComponent(requiredEnv("RABBITMQ_PASSWORD"));
    const host = process.env.RABBITMQ_HOST ?? "localhost";
    const port = process.env.RABBITMQ_PORT ?? "5672";
    return `amqp://${user}:${password}@${host}:${port}/`;
}

/** waitFor repeatedly runs a function (the probe) until that function returns
 * a valid result or a specified timeout is reached.
 */
export async function waitFor<T>(
    description: string,
    probe: () => Promise<T | undefined> | T | undefined,
    options: { timeoutMs?: number; intervalMs?: number } = {},
) {
    const timeoutMs =
        options.timeoutMs ??
        Number(process.env.TEST_PROBE_TIMEOUT_MS) ??
        20 * 1000;
    const intervalMs =
        options.intervalMs ?? Number(process.env.TEST_PROBE_INTERVAL_MS) ?? 500;
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < timeoutMs) {
        try {
            const result = await probe();
            if (result !== undefined) return result;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `Timed out waiting for ${description}${
            lastError instanceof Error ? `: ${lastError.message}` : ""
        }`,
    );
}
