/**
 * A scripted model gateway for tests: an HTTP server that speaks enough of
 * OpenAI Chat Completions at `/v1/chat/completions`, as the Bifrost gateway
 * serves it, to hand back queued turns, and that keeps every request it saw so tests can check the
 * wire shape and that nothing secret was sent.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A JSON body whose fields tests reach into freely. Wire formats are checked
 * by what was sent, not by a type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseJson = Record<string, any>;

export type FakeCall = { name: string; input: unknown };

export type FakeTurn =
    | {
          text?: string;
          calls?: FakeCall[];
          usage?: { input: number; output: number };
      }
    | {
          error: {
              status: number;
              message?: string;
              headers?: Record<string, string>;
              /** OpenAI's `error.param`, for errors that name a parameter. */
              param?: string;
          };
      };

export type SeenRequest = {
    path: string;
    headers: http.IncomingHttpHeaders;
    body: LooseJson;
    /** The raw JSON, for "this string was never sent" checks. */
    raw: string;
    /** Every piece of text sent since the model's last turn, joined by newlines. */
    lastText: string;
};

/** A turn, or a function that writes one after reading the request. */
export type Script = FakeTurn | ((request: SeenRequest) => FakeTurn);

/** Every text string inside a message, whatever the wire format nests it in. */
function textsOf(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) textsOf(v, out);
    else if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        if (record.type === "image" || record.type === "image_url") return out;
        for (const key of ["text", "content"]) {
            if (key in record) textsOf(record[key], out);
        }
    }
    return out;
}

/** The messages after the last assistant turn: what the model is answering now. */
function sinceLastAssistant(messages: unknown[]): unknown[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as { role?: string }).role === "assistant") {
            return messages.slice(i + 1);
        }
    }
    return messages;
}

/**
 * The ref (`e12`) of the first element line in `text` that matches
 * `pattern`, as a snapshot lists it: `[e12] button "Sign in"`.
 */
export function refOf(
    textOrRequest: string | SeenRequest,
    pattern: RegExp,
): string {
    const text =
        typeof textOrRequest === "string" ? textOrRequest : (
            textOrRequest.lastText
        );
    for (const line of text.split("\n")) {
        const m = /^\[(e\d+)\] (.*)$/.exec(line.trim());
        if (m && pattern.test(m[2]!)) return m[1]!;
    }
    throw new Error(`no element matching ${pattern} in:\n${text}`);
}

export class FakeProvider {
    readonly requests: SeenRequest[] = [];
    private readonly scripts: Script[] = [];
    private ids = 0;

    private constructor(
        private readonly server: http.Server,
        readonly origin: string,
    ) {}

    /** The fake as the model gateway: what the store's gateway URL is set to. */
    get gatewayUrl(): string {
        return this.origin;
    }

    /** Where the OpenAI SDK is pointed: the gateway's `/v1`. */
    get baseUrl(): string {
        return `${this.origin}/v1`;
    }

    static async start(): Promise<FakeProvider> {
        let self: FakeProvider | null = null;
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", c => chunks.push(c as Buffer));
            req.on("end", () =>
                self!.handle(req, res, Buffer.concat(chunks).toString("utf8")),
            );
        });
        await new Promise<void>(resolve =>
            server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        self = new FakeProvider(server, `http://127.0.0.1:${port}`);
        return self;
    }

    /** Queues turns; each request takes the next one. */
    queue(...scripts: Script[]): this {
        this.scripts.push(...scripts);
        return this;
    }

    get pending(): number {
        return this.scripts.length;
    }

    reset(): void {
        this.scripts.length = 0;
        this.requests.length = 0;
    }

    close(): Promise<void> {
        return new Promise(resolve => {
            this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }

    private handle(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        raw: string,
    ): void {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const json = (
            status: number,
            body: unknown,
            headers: Record<string, string> = {},
        ) => {
            res.writeHead(status, {
                "content-type": "application/json",
                ...headers,
            });
            res.end(JSON.stringify(body));
        };
        if (path !== "/v1/chat/completions" || req.method !== "POST") {
            return json(404, {
                error: {
                    type: "not_found_error",
                    message: `fake provider: no route ${path}`,
                },
            });
        }
        const body = JSON.parse(raw) as Record<string, unknown>;
        const messages = (body.messages ?? []) as unknown[];
        const seen: SeenRequest = {
            path,
            headers: req.headers,
            body,
            raw,
            lastText: textsOf(sinceLastAssistant(messages)).join("\n"),
        };
        this.requests.push(seen);

        const script = this.scripts.shift();
        if (!script) {
            return json(400, {
                error: {
                    type: "invalid_request_error",
                    message: "fake provider: no scripted turn left",
                },
            });
        }
        let turn: FakeTurn;
        try {
            turn = typeof script === "function" ? script(seen) : script;
        } catch (err) {
            return json(400, {
                error: {
                    type: "invalid_request_error",
                    message: `fake provider script threw: ${err instanceof Error ? err.message : String(err)}`,
                },
            });
        }
        if ("error" in turn) {
            const e = turn.error;
            const message = e.message ?? "scripted failure";
            return json(
                e.status,
                {
                    error: {
                        message,
                        type: "invalid_request_error",
                        param: e.param ?? null,
                        code: null,
                    },
                },
                e.headers ?? {},
            );
        }

        const calls = (turn.calls ?? []).map(call => ({
            ...call,
            id: `call_${++this.ids}`,
        }));
        const usage = turn.usage ?? { input: 100, output: 10 };
        const model = String(body.model ?? "fake-model");
        return json(200, {
            id: `chatcmpl-${++this.ids}`,
            object: "chat.completion",
            created: 0,
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: turn.text ?? null,
                        ...(calls.length > 0 ?
                            {
                                tool_calls: calls.map(c => ({
                                    id: c.id,
                                    type: "function",
                                    function: {
                                        name: c.name,
                                        arguments: JSON.stringify(c.input),
                                    },
                                })),
                            }
                        :   {}),
                    },
                    finish_reason: calls.length > 0 ? "tool_calls" : "stop",
                },
            ],
            usage: {
                prompt_tokens: usage.input,
                completion_tokens: usage.output,
                total_tokens: usage.input + usage.output,
            },
        });
    }
}
