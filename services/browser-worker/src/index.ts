import { createObjectStoreClient } from "@watchthatsite/cloudflare/client";
import { sql } from "@watchthatsite/db/pool";
import amqp from "amqplib";
import type http from "node:http";
import { compare } from "./agent/compare.js";
import { AgentJobError, type AgentDeps } from "./agent/job.js";
import { plan } from "./agent/plan.js";
import { Recorder } from "./agent/record.js";
import { createRepairer } from "./agent/repair.js";
import { suggest } from "./agent/suggest.js";
import {
    browserPoolInstances,
    contextsPerBrowser,
    defaultAgentAddr,
    jobQueue,
    jobWorkers,
} from "./config/constants.js";
import { createScrapeJobHandler } from "./handler/scrape-job.js";
import { closeServer, createAgentServer, listen } from "./http/server.js";
import { createBlockerProvider } from "./lib/blocking.js";
import { BrowserPool } from "./lib/browser-pool.js";
import { Publisher } from "./lib/publisher.js";
import { logger } from "./logger.js";
import { createMacroRunner } from "./macro/run.js";
import { testMacro } from "./macro/test.js";
import { Router, type QueueHandlerMap } from "./router.js";
import { PgStore } from "./store/pg.js";
import type { ObjectStore } from "./types.js";

/** A recording still marked `recording` after this long was left by a worker that died. */
const staleRecordingMs = 15 * 60_000;

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name}`);
    }

    return value;
}

/**
 * Adapts the object-store Worker client to the worker's ObjectStore, or
 * returns null when storage is not configured.
 *
 * Storage is optional so the worker can boot without it, but every Capture
 * uploads a screenshot, so without it Runs publish an `error` Capture
 * ("Screenshot storage is not configured"), and the Agent has no screenshots
 * or blocks to look at.
 */
function createObjectStore(): ObjectStore | null {
    const baseUrl = process.env.R2_WORKER_URL;
    const token = process.env.R2_API_TOKEN;

    if (!baseUrl || !token) {
        logger.warn(
            "[worker] R2_WORKER_URL/R2_API_TOKEN not set; Captures will fail",
        );
        return null;
    }

    const client = createObjectStoreClient({ baseUrl, token });
    return {
        putObject: (key, body, options) => client.putObject(key, body, options),
        getObject: key => client.getObject(key),
    };
}

function getRabbitMqUrl(): string {
    const user = encodeURIComponent(requiredEnv("RABBITMQ_USER"));
    const password = encodeURIComponent(requiredEnv("RABBITMQ_PASSWORD"));
    const host = requiredEnv("RABBITMQ_HOST");
    const port = requiredEnv("RABBITMQ_PORT");

    return `amqp://${user}:${password}@${host}:${port}/`;
}

async function main() {
    logger.info("[worker] Starting browser worker...");

    let connection: amqp.ChannelModel | null = null;
    let publisherChannel: amqp.ConfirmChannel | null = null;
    let router: Router | null = null;
    let pool: BrowserPool | null = null;
    let agentServer: http.Server | null = null;
    let recorder: Recorder | null = null;
    let isShuttingDown = false;

    const shutdown = async (exitCode = 0) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info("[worker] shutting down...");
        const forceExit = setTimeout(() => {
            logger.error(
                "[worker] graceful shutdown timed out after 30s, force exiting",
            );
            process.exit(1);
        }, 30_000);
        forceExit.unref();

        try {
            // 1. Drain all consumers (cancel + wait for in-flight acks) and close
            //    their channels before touching the connection. This guarantees no
            //    in-flight message acknowledgements are lost.
            await router?.close();
            // 2. Stop the agent API the same way: no new requests, in-flight
            //    ones finish. Recordings run in the background, so they are
            //    stopped and marked failed rather than left as `recording`.
            if (agentServer) await closeServer(agentServer);
            await recorder?.close();
            // 3. Close the publisher channel now that no more results will be sent.
            await publisherChannel?.close();
            // 4. Close the browser pool. By this point drain() has already waited
            //    for activeWorkers === 0, so all scrape contexts have been released.
            await pool?.close();
            if (connection) {
                await connection.close();
            }
            await sql.end({ timeout: 5 }).catch(() => undefined);

            logger.info("[worker] closed all connections cleanly");
        } catch (err) {
            logger.error({ err }, "[worker] error during graceful shutdown");
        } finally {
            clearTimeout(forceExit);
            process.exit(exitCode);
        }
    };

    process.once("SIGINT", () => {
        void shutdown(0);
    });
    process.once("SIGTERM", () => {
        void shutdown(0);
    });

    try {
        const objectStore = createObjectStore();

        pool = new BrowserPool({
            maxInstances: browserPoolInstances,
            maxContextsPerBrowser: contextsPerBrowser,
        });
        await pool.launch();
        logger.info(
            { instances: browserPoolInstances, contextsPerBrowser },
            "[worker] browser pool ready",
        );

        // Postgres holds the Macros, the secrets they type, the owners'
        // model connections, and the trace this worker writes.
        await sql`SELECT 1`;
        const store = new PgStore(sql);
        if (!process.env.ENCRYPTION_KEY) {
            logger.warn(
                "[worker] ENCRYPTION_KEY is not set; secrets and model keys cannot be read",
            );
        }
        const blockers = createBlockerProvider({ logger });
        const agentDeps: AgentDeps = { store, objectStore, logger };
        const macros = createMacroRunner({
            store,
            objectStore,
            repairer: createRepairer(agentDeps),
        });
        const activePool = pool;
        const activeRecorder = new Recorder({
            ...agentDeps,
            pool: activePool,
            blockers,
        });
        recorder = activeRecorder;
        const stale = await store.failStaleRecordings(staleRecordingMs);
        if (stale > 0) {
            logger.warn({ count: stale }, "[worker] failed stale recordings");
        }

        const token = process.env.AGENT_TOKEN;
        if (!token) {
            logger.warn(
                "[worker] AGENT_TOKEN is not set; the agent API serves only /internal/health",
            );
        }
        agentServer = createAgentServer({
            token,
            logger,
            api: {
                compare: req => compare(agentDeps, req),
                plan: req => plan(agentDeps, req),
                suggest: req =>
                    suggest({ ...agentDeps, pool: activePool, blockers }, req),
                record: async req => ({
                    macro_id: await activeRecorder.start(req),
                }),
                testMacro: async (monitorId, steps) => {
                    const monitor = await store.getMonitor(monitorId);
                    if (!monitor) {
                        throw new AgentJobError(
                            "not_found",
                            "There is no such Monitor",
                        );
                    }
                    return testMacro(
                        {
                            store,
                            pool: activePool,
                            blockers,
                            objectStore,
                            logger,
                        },
                        monitor,
                        steps,
                    );
                },
            },
        });
        const bound = await listen(
            agentServer,
            process.env.AGENT_ADDR || defaultAgentAddr,
        );
        logger.info(bound, "[worker] agent API listening");

        connection = await amqp.connect(getRabbitMqUrl());

        connection.on("error", err => {
            logger.error({ err }, "[worker] RabbitMQ connection error");
        });

        connection.on("close", () => {
            if (!isShuttingDown) {
                logger.error(
                    "[worker] RabbitMQ connection closed unexpectedly!",
                );
                void shutdown(1);
            }
        });

        publisherChannel = await connection.createConfirmChannel();
        const publisher = new Publisher(publisherChannel, logger);

        const queueHandlerMap: QueueHandlerMap[] = [
            {
                queue: {
                    name: jobQueue,
                    workerCount: jobWorkers,
                },
                handler: createScrapeJobHandler({
                    logger,
                    pool,
                    publishResult: result => publisher.publishResult(result),
                    objectStore,
                    blockers,
                    macros,
                }),
            },
        ];
        router = new Router(queueHandlerMap, connection, logger);
        await router.run();
    } catch (err) {
        logger.error(
            { err },
            err instanceof Error ?
                err.message
            :   "Fatal error during startup or execution",
        );
        await shutdown(1);
    }
}

main().catch(err => {
    // Fallback in case something outside the try/catch fails
    logger.error({ err }, "Unhandled fatal error");
    process.exit(1);
});
