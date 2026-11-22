import amqp from "amqplib";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requiredEnv } from "../lib/env";
import { getAmqpUrl, waitFor } from "../lib/utils";
import { ResendWebhookInterceptor } from "./resend-wbhk-interceptor";
import {
    EMAIL_QUEUE,
    NOTIFICATIONS_DLQ,
    TEST_TIMEOUT_MS,
    uniqueBouncedRecipient,
    uniqueRecipient,
    uniqueSubject,
} from "./utils";

let amqpConnection: Awaited<ReturnType<typeof amqp.connect>>;
let amqpChannel: Awaited<ReturnType<typeof amqpConnection.createChannel>>;
let resendWebhook: ResendWebhookInterceptor;

type EmailAttachment = {
    filename: string;
    content_type: string;
    data: string;
};

async function publishEmailNotification({
    recipient,
    subject,
    text,
    html,
    attachments,
}: {
    recipient: string;
    subject: string;
    text?: string;
    html?: string;
    attachments?: EmailAttachment[];
}) {
    const payload: {
        subject: string;
        reciever: string;
        text?: string;
        html?: string;
        attachments?: EmailAttachment[];
    } = {
        subject,
        reciever: recipient,
    };
    if (text !== undefined) payload.text = text;
    if (html !== undefined) payload.html = html;
    if (attachments !== undefined) payload.attachments = attachments;

    const notification = {
        channel: EMAIL_QUEUE,
        payload,
        created_at: new Date().toISOString(),
    };

    return amqpChannel.sendToQueue(
        EMAIL_QUEUE,
        Buffer.from(JSON.stringify(notification)),
        {
            contentType: "application/json",
            deliveryMode: 2,
            messageId: randomUUID(),
            timestamp: Math.floor(Date.now() / 1000),
        },
    );
}

async function getMessageCount(queue: string) {
    const state = await amqpChannel.checkQueue(queue);
    return state.messageCount;
}

async function purgeQueues() {
    await Promise.all([
        amqpChannel.purgeQueue(EMAIL_QUEUE),
        amqpChannel.purgeQueue(NOTIFICATIONS_DLQ),
    ]);
}

async function waitForEmailQueueToDrain() {
    await waitFor(
        `${EMAIL_QUEUE} to drain`,
        async () =>
            (await getMessageCount(EMAIL_QUEUE)) === 0 ? true : undefined,
        { timeoutMs: 20_000 },
    );
}

async function waitForDLQCount(expected: number) {
    await waitFor(
        `${NOTIFICATIONS_DLQ} message count to become ${expected}`,
        async () =>
            (await getMessageCount(NOTIFICATIONS_DLQ)) === expected ?
                true
            :   undefined,
        { timeoutMs: 20_000 },
    );
}

async function expectNoWebhookEvent(subject: string) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    expect(resendWebhook.eventsForSubject(subject)).toEqual([]);
}

function tinyPngAttachment(filename = "pixel.png"): EmailAttachment {
    return {
        filename,
        content_type: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    };
}

function oversizedAttachment(): EmailAttachment {
    return {
        filename: "too-large.png",
        content_type: "image/png",
        data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
    };
}

beforeAll(async () => {
    requiredEnv("RABBITMQ_USER");
    requiredEnv("RABBITMQ_PASSWORD");

    resendWebhook = new ResendWebhookInterceptor();
    await resendWebhook.start();

    amqpConnection = await amqp.connect(getAmqpUrl());
    amqpChannel = await amqpConnection.createChannel();
}, TEST_TIMEOUT_MS);

beforeEach(async () => {
    resendWebhook.reset();
    await purgeQueues();
});

afterAll(async () => {
    await purgeQueues().catch(() => undefined);
    await amqpChannel?.close().catch(() => undefined);
    await amqpConnection?.close().catch(() => undefined);
    await resendWebhook?.stop().catch(() => undefined);
}, TEST_TIMEOUT_MS);

describe("notifications email worker", () => {
    it(
        "sends one email notification",
        async () => {
            const subject = uniqueSubject("single");
            const recipient = uniqueRecipient("single");

            await publishEmailNotification({
                recipient,
                subject,
                text: `Notification e2e body for ${subject}`,
            });
            await waitForEmailQueueToDrain();

            const event = await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient,
            });
            expect(event.data.email_id).toBeTruthy();
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sends email with text",
        async () => {
            const subject = uniqueSubject("text");
            const recipient = uniqueRecipient("text");

            await publishEmailNotification({
                recipient,
                subject,
                text: `Notification e2e text body for ${subject}`,
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sends email with html",
        async () => {
            const subject = uniqueSubject("html");
            const recipient = uniqueRecipient("html");

            await publishEmailNotification({
                recipient,
                subject,
                html: `<p>Notification e2e html body for <strong>${subject}</strong></p>`,
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sends email with text and html",
        async () => {
            const subject = uniqueSubject("text-html");
            const recipient = uniqueRecipient("text-html");

            await publishEmailNotification({
                recipient,
                subject,
                text: `Notification e2e text body for ${subject}`,
                html: `<p>Notification e2e html body for <strong>${subject}</strong></p>`,
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sends email with text and attachment",
        async () => {
            const subject = uniqueSubject("text-attachment");
            const recipient = uniqueRecipient("text-attachment");

            await publishEmailNotification({
                recipient,
                subject,
                text: `Notification e2e text body for ${subject}`,
                attachments: [tinyPngAttachment()],
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sends email with html and attachment",
        async () => {
            const subject = uniqueSubject("html-attachment");
            const recipient = uniqueRecipient("html-attachment");

            await publishEmailNotification({
                recipient,
                subject,
                html: `<p>Notification e2e html body for <strong>${subject}</strong></p>`,
                attachments: [tinyPngAttachment()],
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "dead-letters an invalid email string",
        async () => {
            const subject = uniqueSubject("invalid-email");
            const dlqBefore = await getMessageCount(NOTIFICATIONS_DLQ);

            await publishEmailNotification({
                recipient: "not-an-email-address",
                subject,
                text: `Notification e2e body for ${subject}`,
            });
            await waitForEmailQueueToDrain();

            await waitForDLQCount(dlqBefore + 1);
            await expectNoWebhookEvent(subject);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "dead-letters empty text and html",
        async () => {
            const subject = uniqueSubject("empty-body");
            const recipient = uniqueRecipient("empty-body");
            const dlqBefore = await getMessageCount(NOTIFICATIONS_DLQ);

            await publishEmailNotification({
                recipient,
                subject,
                text: "",
                html: "",
            });
            await waitForEmailQueueToDrain();

            await waitForDLQCount(dlqBefore + 1);
            await expectNoWebhookEvent(subject);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "dead-letters attachments greater than 10 mb",
        async () => {
            const subject = uniqueSubject("large-attachment");
            const recipient = uniqueRecipient("large-attachment");
            const dlqBefore = await getMessageCount(NOTIFICATIONS_DLQ);

            await publishEmailNotification({
                recipient,
                subject,
                text: `Notification e2e body for ${subject}`,
                attachments: [oversizedAttachment()],
            });
            await waitForEmailQueueToDrain();

            await waitForDLQCount(dlqBefore + 1);
            await expectNoWebhookEvent(subject);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sends multiple email notifications",
        async () => {
            const subject = uniqueSubject("multiple");
            const recipients = [
                uniqueRecipient("multiple-1"),
                uniqueRecipient("multiple-2"),
                uniqueRecipient("multiple-3"),
            ];

            await Promise.all(
                recipients.map(recipient =>
                    publishEmailNotification({
                        recipient,
                        subject,
                        text: `Notification e2e body for ${subject} to ${recipient}`,
                    }),
                ),
            );
            await waitForEmailQueueToDrain();

            await Promise.all(
                recipients.map(recipient =>
                    resendWebhook.waitForEvent({
                        eventType: "email.sent",
                        subject,
                        recipient,
                    }),
                ),
            );
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "dead-letters only the invalid receiver message",
        async () => {
            const subject = uniqueSubject("one-invalid");
            const validRecipient = uniqueRecipient("one-invalid");
            const dlqBefore = await getMessageCount(NOTIFICATIONS_DLQ);

            await publishEmailNotification({
                recipient: validRecipient,
                subject,
                text: `Notification e2e body for ${subject}`,
            });
            await publishEmailNotification({
                recipient: "not-an-email-address",
                subject,
                text: `Notification e2e body for ${subject}`,
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.sent",
                subject,
                recipient: validRecipient,
            });
            await waitForDLQCount(dlqBefore + 1);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "reports bounced recipients through Resend webhooks",
        async () => {
            const subject = uniqueSubject("bounced");
            const recipient = uniqueBouncedRecipient("bounced");

            await publishEmailNotification({
                recipient,
                subject,
                text: `Notification e2e body for ${subject}`,
            });
            await waitForEmailQueueToDrain();

            await resendWebhook.waitForEvent({
                eventType: "email.bounced",
                subject,
                recipient,
            });
            expect(await getMessageCount(NOTIFICATIONS_DLQ)).toBe(0);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "dead-letters malformed payloads without sending email",
        async () => {
            const subject = uniqueSubject("malformed");
            const dlqBefore = await getMessageCount(NOTIFICATIONS_DLQ);

            await publishEmailNotification({
                recipient: "",
                subject,
                text: `Notification e2e body for ${subject}`,
            });
            await waitForEmailQueueToDrain();

            await expectNoWebhookEvent(subject);
            await waitForDLQCount(dlqBefore + 1);
        },
        TEST_TIMEOUT_MS,
    );
});
