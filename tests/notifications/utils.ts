import { randomUUID } from "node:crypto";

export const EMAIL_QUEUE = "notifications.email";
export const NOTIFICATIONS_DLQ = "dlq.notifications";
export const TEST_TIMEOUT_MS = 60_000;

export function uniqueSubject(label: string) {
    return `watchthatsite notifications e2e ${label} ${randomUUID()}`;
}

export function uniqueRecipient(label: string) {
    return `delivered+watchthatsite-${label}-${randomUUID()}@resend.dev`;
}

export function uniqueBouncedRecipient(label: string) {
    return `bounced+watchthatsite-${label}-${randomUUID()}@resend.dev`;
}
