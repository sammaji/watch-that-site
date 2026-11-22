import type { ScrapeJob } from "@watchthatsite/types";
import type { Channel, ConsumeMessage } from "amqplib";
import type { Logger } from "pino";
import { errors } from "playwright-core";
import type { Handler } from "../handler/scrape-job.js";
import type { QueueConfig } from "../router.js";

export class Consumer {
    private readonly channel: Channel;
    private readonly queueConfig: QueueConfig;
    private readonly handler: Handler;
    private readonly logger: Logger;

    private activeWorkers = 0;
    private consumerTag = "";

    constructor(
        channel: Channel,
        queueConfig: QueueConfig,
        handler: Handler,
        logger: Logger,
    ) {
        this.channel = channel;
        this.queueConfig = queueConfig;
        this.handler = handler;
        this.logger = logger;
    }

    /**
     * Sets the prefetch limit on the channel and begins consuming.
     * Blocks (keeps the Promise pending) until the RabbitMQ channel closes.
     * Resolves cleanly (no error) on graceful shutdown.
     * Rejects with an Error if the delivery channel closes unexpectedly —
     * the Router uses this signal to decide whether to restart.
     */
    async run(): Promise<void> {
        await this.channel.prefetch(this.queueConfig.workerCount);

        const { consumerTag } = await this.channel.consume(
            this.queueConfig.name,
            async (msg: ConsumeMessage | null) => {
                if (!msg) {
                    // RabbitMQ sends null to signal the consumer was cancelled server-side
                    this.logger.warn(
                        { queue: this.queueConfig.name },
                        "[consumer] consumer cancelled by RabbitMQ server",
                    );
                    this.channel.emit(
                        "error",
                        new Error("consumer cancelled by RabbitMQ server"),
                    );
                    return;
                }

                this.activeWorkers++;
                // Intentionally not awaited — fire and forget, just like Go goroutines.
                // This allows multiple messages to be processed concurrently.
                void this.process(msg).finally(() => {
                    this.activeWorkers--;
                });
            },
            { noAck: false },
        );

        this.consumerTag = consumerTag;

        this.logger.info(
            {
                queue: this.queueConfig.name,
                workerCount: this.queueConfig.workerCount,
                consumerTag,
            },
            "[consumer] consumer started",
        );

        // Block until the channel emits "close".
        // The Router listens to the resolved/rejected value to decide on restart.
        return new Promise((resolve, reject) => {
            this.channel.once("close", () => resolve());
            this.channel.once("error", (err: Error) => reject(err));
        });
    }

    /**
     * Gracefully drains the consumer:
     * 1. Cancels the consumer so RabbitMQ stops delivering new messages.
     * 2. Waits for all currently in-flight handlers to finish and ack/nack.
     *
     * This must be called before channel.close() on graceful shutdown to
     * avoid losing in-flight message acknowledgements, which would cause
     * RabbitMQ to requeue those messages and produce duplicate processing.
     */
    async drain(): Promise<void> {
        // Stop RabbitMQ from pushing new messages to this consumer.
        await this.channel.cancel(this.consumerTag);

        this.logger.info(
            { queue: this.queueConfig.name, activeWorkers: this.activeWorkers },
            "[consumer] consumer cancelled, waiting for in-flight handlers to finish",
        );

        // Wait for all in-flight handlers to call ack/nack and decrement activeWorkers.
        await new Promise<void>(resolve => {
            if (this.activeWorkers === 0) {
                resolve();
                return;
            }
            const check = setInterval(() => {
                if (this.activeWorkers === 0) {
                    clearInterval(check);
                    resolve();
                }
            }, 100);
        });

        this.logger.info(
            { queue: this.queueConfig.name },
            "[consumer] all in-flight handlers finished, ready to close channel",
        );
    }

    // Responsible for processing the job
    private async process(msg: ConsumeMessage): Promise<void> {
        const deliveryTag = msg.fields.deliveryTag;
        const log = this.logger.child({
            queue: this.queueConfig.name,
            deliveryTag,
        });

        log.debug("[consumer] processing message");
        let payload: ScrapeJob | null = null;
        try {
            payload = this.handler.validate(msg.content.toString());
            await this.handler.execute(payload);
            this.channel.ack(msg);
            log.info("[consumer] message processed and acked");
        } catch (err) {
            if (err instanceof errors.TimeoutError) {
                log.error(
                    {
                        err,
                        deliveryTag: msg.fields.deliveryTag,
                        message: err.message,
                    },
                    "[worker] Playwright timeout while processing message",
                );
            } else {
                log.error(
                    {
                        err,
                        message:
                            err instanceof Error ?
                                err.message
                            :   "Unknown error occurred while processing message",
                    },
                    "[worker] error processing message",
                );
            }

            // If the job parsed, report the scrape failure to the scheduler and
            // ack - the failure has been handled. If reporting itself fails, or
            // the message never parsed, nack without requeue so the DLQ takes it.
            if (payload?.run_id) {
                try {
                    await this.handler.reportFailure(payload, err);
                    this.channel.ack(msg);
                    log.info(
                        "[consumer] scrape failure reported and message acked",
                    );
                    return;
                } catch (reportErr) {
                    log.error(
                        { err: reportErr },
                        "[consumer] failed to report scrape failure",
                    );
                }
            }

            try {
                this.channel.nack(msg, false, false);
            } catch (nackErr) {
                log.error(
                    { err: nackErr },
                    "[consumer] failed to nack message, channel may be closed",
                );
            }
        }
    }
}
