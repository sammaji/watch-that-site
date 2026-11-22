import amqp from "amqplib";
import type { Logger } from "pino";
import type { Handler } from "./handler/scrape-job.js";
import { Consumer } from "./lib/consumer.js";
export type QueueConfig = {
    name: string;
    workerCount: number;
};
export type QueueHandlerMap = {
    queue: QueueConfig;
    handler: Handler;
};

type ActiveEntry = {
    consumer: Consumer;
    channel: amqp.Channel;
};

export class Router {
    readonly queueHandlerMap: QueueHandlerMap[];
    readonly logger: Logger;
    readonly connection: amqp.ChannelModel;

    // Tracks the currently running consumer + channel per queue name.
    // Used by close() to drain and shut down each consumer during graceful shutdown.
    private readonly activeConsumers = new Map<string, ActiveEntry>();

    constructor(
        queueHandlerMap: QueueHandlerMap[],
        connection: amqp.ChannelModel,
        logger: Logger,
    ) {
        this.queueHandlerMap = queueHandlerMap;
        this.connection = connection;
        this.logger = logger;
    }

    async runWithRestart(m: QueueHandlerMap): Promise<void> {
        const { queue, handler } = m;
        let backoff = 1000;
        const maxBackoff = 30000;

        while (true) {
            let channel: amqp.Channel;
            try {
                channel = await this.connection.createChannel();
            } catch (err) {
                throw new Error(
                    `open channel for ${queue.name}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            try {
                const consumer = new Consumer(
                    channel,
                    queue,
                    handler,
                    this.logger,
                );

                // Register the active consumer so close() can drain it on shutdown.
                this.activeConsumers.set(queue.name, { consumer, channel });

                await consumer.run();

                break;
            } catch (err) {
                // Channel died unexpectedly — log and retry with backoff.
                this.logger.warn(
                    { queue: queue.name, err, backoff },
                    "consumer exited unexpectedly, restarting",
                );
            } finally {
                this.activeConsumers.delete(queue.name);

                try {
                    // Explicitly close to prevent channel leaks if consumer startup fails.
                    // If the channel is already closed (via graceful shutdown or RabbitMQ error),
                    // this throws an IllegalOperationError which we safely swallow.
                    await channel.close();
                } catch {
                    // Swallow IllegalOperationError from already closed channels.
                }
            }
            await new Promise(resolve => setTimeout(resolve, backoff));

            if (backoff >= maxBackoff) {
                // Log a fatal-level alert so operators are paged, but do NOT throw.
                // Throwing here would propagate through Promise.all in run() and crash
                // the entire process, taking down all other healthy queue consumers.
                // By breaking, only this specific queue stops retrying while others
                // continue processing normally.
                this.logger.fatal(
                    { queue: queue.name },
                    "[router] consumer failed repeatedly and max backoff was reached — this queue will no longer be consumed. Restart the worker to recover.",
                );
                break;
            }

            backoff = Math.min(backoff * 2, maxBackoff);
        }
    }

    /**
     * Gracefully shuts down all active consumers and their channels.
     * Called by index.ts shutdown() before closing the AMQP connection.
     *
     * Sequence per queue:
     *   1. consumer.drain() — cancel consumer tag + wait for activeWorkers === 0
     *   2. channel.close()  — send AMQP channel.close handshake to the server
     *
     * Uses Promise.allSettled so one failing drain does not prevent the others
     * from completing cleanly.
     */
    async close(): Promise<void> {
        await Promise.allSettled(
            [...this.activeConsumers.values()].map(
                async ({ consumer, channel }) => {
                    try {
                        await consumer.drain();
                        await channel.close();
                    } catch (err) {
                        this.logger.error(
                            { err },
                            "[router] error while draining consumer during shutdown",
                        );
                    }
                },
            ),
        );
    }

    async run(): Promise<void> {
        const promises = this.queueHandlerMap.map(m => {
            return this.runWithRestart(m);
        });

        await Promise.all(promises);
    }
}
