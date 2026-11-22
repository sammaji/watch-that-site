import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { waitFor } from "../lib/utils";

export const RESEND_WEBHOOK_PATH = "/resend-webhook";

export type ResendWebhookEvent = {
    type: string;
    created_at: string;
    data: {
        email_id?: string;
        from?: string;
        to?: string[];
        subject?: string;
        [key: string]: unknown;
    };
};

export class ResendWebhookInterceptor {
    readonly path: string;
    private readonly events: ResendWebhookEvent[] = [];
    private readonly server: ReturnType<typeof createServer>;

    constructor({
        path = RESEND_WEBHOOK_PATH,
    }: {
        path?: string;
    } = {}) {
        this.path = path;
        this.server = createServer((req, res) => {
            void this.handleRequest(req, res);
        });
    }

    async start(
        port = Number(process.env.TEST_NOTIFICATIONS_WEBHOOK_PORT ?? 0),
    ) {
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(port, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
    }

    async stop() {
        if (!this.server.listening) return;
        await new Promise<void>((resolve, reject) => {
            this.server.close(error => (error ? reject(error) : resolve()));
        });
    }

    reset() {
        this.events.length = 0;
    }

    findEvent({
        eventType,
        subject,
        recipient,
    }: {
        eventType: string;
        subject: string;
        recipient: string;
    }) {
        return this.events.find(
            event =>
                event.type === eventType &&
                event.data.subject === subject &&
                event.data.to?.includes(recipient),
        );
    }

    async waitForEvent({
        eventType,
        subject,
        recipient,
        timeoutMs = 45_000,
    }: {
        eventType: string;
        subject: string;
        recipient: string;
        timeoutMs?: number;
    }) {
        return waitFor(
            `Resend webhook ${eventType} for ${subject} to ${recipient}`,
            () => this.findEvent({ eventType, subject, recipient }),
            { timeoutMs, intervalMs: 500 },
        );
    }

    eventsForSubject(subject: string) {
        return this.events.filter(event => event.data.subject === subject);
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse) {
        if (req.method !== "POST" || req.url !== this.path) {
            res.writeHead(404).end();
            return;
        }

        const body = await this.readRequestBody(req);
        this.events.push(JSON.parse(body) as ResendWebhookEvent);
        res.writeHead(200).end("ok");
    }

    private readRequestBody(req: IncomingMessage) {
        return new Promise<string>((resolve, reject) => {
            let body = "";
            req.setEncoding("utf8");
            req.on("data", chunk => {
                body += chunk;
            });
            req.on("end", () => resolve(body));
            req.on("error", reject);
        });
    }
}
