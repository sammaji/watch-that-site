import type { Capture } from "@watchthatsite/types";
import type { ConfirmChannel } from "amqplib";
import type { Logger } from "pino";
import { resultExchange, resultRoutingKey } from "../config/constants.js";

/**
 * Publishes Captures on a RabbitMQ confirm channel. `waitForConfirms`
 * blocks until the broker has durably accepted the message, so the consumer
 * can safely ack the originating job only after the result is guaranteed
 * delivered.
 */
export class Publisher {
    private readonly channel: ConfirmChannel;
    private readonly logger: Logger;

    constructor(channel: ConfirmChannel, logger: Logger) {
        this.channel = channel;
        this.logger = logger;
    }

    async publishResult(result: Capture): Promise<void> {
        const content = Buffer.from(JSON.stringify(result));

        this.channel.publish(resultExchange, resultRoutingKey, content, {
            persistent: true,
            contentType: "application/json",
        });

        await this.channel.waitForConfirms();

        this.logger.debug(
            { runId: result.run_id, status: result.status },
            "[publisher] capture published",
        );
    }
}
