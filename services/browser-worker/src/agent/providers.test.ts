import type { ProviderKind } from "@watchthatsite/types";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedConnection } from "../store/store.js";
import { FakeProvider, type LooseJson } from "../testing/fake-provider.js";
import { runAgent, validateInput, type AgentTool } from "./loop.js";
import {
    CREDIT_USED_UP,
    ProviderError,
    withRetries,
} from "./providers/errors.js";
import { adapterFor } from "./providers/index.js";
import {
    text,
    type ContentPart,
    type ModelRequest,
    type ToolDef,
} from "./types.js";

const KEY = "sk-live-0123456789abcdefghij";
let provider: FakeProvider;
let png: Buffer;

beforeAll(async () => {
    provider = await FakeProvider.start();
    png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#ff0000" },
    })
        .png()
        .toBuffer();
});
afterAll(() => provider.close());
beforeEach(() => provider.reset());

const connection = (kind: ProviderKind): ResolvedConnection => ({
    id: "c1",
    kind,
    name: "Fake",
    baseUrl: provider.baseUrl,
    apiKey: KEY,
    model: "test-model",
});

const lookTool: ToolDef = {
    name: "look",
    description: "Looks at something.",
    inputSchema: {
        type: "object",
        properties: { at: { type: "string" } },
        required: ["at"],
        additionalProperties: false,
    },
};

/** A two-turn conversation: the model called `look`, and got text and an image back. */
const request: ModelRequest = {
    system: "You are a test.",
    tools: [lookTool],
    messages: [
        {
            role: "user",
            content: [
                text("Look at the page."),
                {
                    type: "image",
                    mediaType: "image/png",
                    data: Buffer.from("first"),
                },
            ],
        },
        {
            role: "assistant",
            text: "",
            toolCalls: [
                { id: "call_a", name: "look", input: { at: "header" } },
            ],
            raw: null,
        },
        {
            role: "tool",
            results: [
                {
                    callId: "call_a",
                    name: "look",
                    content: [
                        text("The header."),
                        {
                            type: "image",
                            mediaType: "image/jpeg",
                            data: Buffer.from("shot"),
                        },
                    ],
                    isError: false,
                },
            ],
        },
    ],
};

describe("openai adapter", () => {
    it("speaks Chat Completions: tools, data-URL images, and tool images in a following user message", async () => {
        provider.queue({
            calls: [{ name: "look", input: { at: "footer" } }],
            usage: { input: 200, output: 9 },
        });
        const turn = await adapterFor(connection("openai")).complete(request);

        const seen = provider.requests[0]!;
        expect(seen.path).toBe("/v1/chat/completions");
        expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
        const body = seen.body as LooseJson;
        for (const banned of [
            "temperature",
            "max_tokens",
            "max_completion_tokens",
            "top_p",
            "reasoning_effort",
        ]) {
            expect(body, banned).not.toHaveProperty(banned);
        }
        expect(body.tools).toEqual([
            {
                type: "function",
                function: {
                    name: "look",
                    description: "Looks at something.",
                    parameters: lookTool.inputSchema,
                },
            },
        ]);
        expect(body.messages).toEqual([
            { role: "system", content: "You are a test." },
            {
                role: "user",
                content: [
                    { type: "text", text: "Look at the page." },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/png;base64,${Buffer.from("first").toString("base64")}`,
                        },
                    },
                ],
            },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_a",
                        type: "function",
                        function: {
                            name: "look",
                            arguments: '{"at":"header"}',
                        },
                    },
                ],
            },
            {
                role: "tool",
                tool_call_id: "call_a",
                content:
                    "The header.\n(1 image from this tool follow in the next message, labelled look call_a.)",
            },
            {
                role: "user",
                content: [
                    { type: "text", text: "Images returned by look (call_a):" },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/jpeg;base64,${Buffer.from("shot").toString("base64")}`,
                        },
                    },
                ],
            },
        ]);
        expect(turn.toolCalls).toEqual([
            { id: expect.any(String), name: "look", input: { at: "footer" } },
        ]);
        expect(turn.usage).toEqual({ inputTokens: 200, outputTokens: 9 });
        expect(turn.stop).toBe("tool_use");
    });

    it("turns reasoning off once when the provider says tools need it", async () => {
        provider.queue(
            {
                error: {
                    status: 400,
                    param: "reasoning_effort",
                    message:
                        "Function tools with reasoning_effort are not supported for this model in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
                },
            },
            { text: "ok" },
            { text: "ok again" },
        );
        const adapter = adapterFor(connection("openai"));
        expect((await adapter.complete(request)).text).toBe("ok");
        expect(provider.requests[1]!.body).toMatchObject({
            reasoning_effort: "none",
        });
        // Remembered for the rest of the job.
        await adapter.complete(request);
        expect(provider.requests).toHaveLength(3);
        expect(provider.requests[2]!.body).toMatchObject({
            reasoning_effort: "none",
        });
    });

    it("requires a tool call, and stops asking a server that refuses that", async () => {
        provider.queue(
            {
                error: {
                    status: 400,
                    param: "tool_choice",
                    message: "tool_choice 'required' is not supported.",
                },
            },
            { text: "ok" },
            { text: "ok again" },
        );
        const adapter = adapterFor(connection("openai"));
        expect((await adapter.complete(request)).text).toBe("ok");
        expect(provider.requests[0]!.body).toMatchObject({
            tool_choice: "required",
        });
        expect(provider.requests[1]!.body).not.toHaveProperty("tool_choice");
        // Remembered for the rest of the job.
        await adapter.complete(request);
        expect(provider.requests).toHaveLength(3);
        expect(provider.requests[2]!.body).not.toHaveProperty("tool_choice");
    });

    it("reports arguments that are not JSON instead of throwing", async () => {
        const { readOpenAI } = await import("./providers/openai.js");
        const turn = readOpenAI({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "m",
            choices: [
                {
                    index: 0,
                    finish_reason: "tool_calls",
                    logprobs: null,
                    message: {
                        role: "assistant",
                        content: null,
                        refusal: null,
                        tool_calls: [
                            {
                                id: "c",
                                type: "function",
                                function: {
                                    name: "look",
                                    arguments: "{not json",
                                },
                            },
                        ],
                    },
                },
            ],
        } as never);
        expect(turn.toolCalls[0]).toMatchObject({
            name: "look",
            inputError: "the arguments were not valid JSON",
        });
    });
});

describe.each<ProviderKind>(["openai"])("%s adapter: failures", kind => {
    it("retries a rate limit, honouring retry-after, then succeeds", async () => {
        provider.queue(
            {
                error: {
                    status: 429,
                    message: "slow down",
                    headers: { "retry-after": "0" },
                },
            },
            {
                error: {
                    status: 500,
                    message: "oops",
                    headers: { "retry-after-ms": "5" },
                },
            },
            { text: "fine" },
        );
        const started = Date.now();
        const turn = await adapterFor(connection(kind)).complete(request);
        expect(turn.text).toBe("fine");
        expect(provider.requests).toHaveLength(3);
        // The provider's own delays replaced the backoff.
        expect(Date.now() - started).toBeLessThan(450);
    });

    it("does not retry a bad key, and never repeats the key in the error", async () => {
        provider.queue({
            error: {
                status: 401,
                message: `Incorrect API key provided: ${KEY}. Check it.`,
            },
        });
        const failure = await adapterFor(connection(kind))
            .complete(request)
            .catch(e => e);
        expect(failure).toBeInstanceOf(ProviderError);
        expect(failure.status).toBe(401);
        expect(failure.retryable).toBe(false);
        expect(failure.message).toContain("rejected the API key");
        expect(failure.message).not.toContain(KEY);
        expect(provider.requests).toHaveLength(1);
    });

    it("turns a spent platform credit into words the owner can act on", async () => {
        const spent = {
            error: {
                status: 402,
                message:
                    "Budget exceeded: vk_model_config * on wts budget exceeded: 10.0000 >= 10.0000 dollars",
            },
        };
        provider.queue(spent);
        const failure = await adapterFor({
            ...connection(kind),
            managed: true,
        })
            .complete(request)
            .catch(e => e);
        expect(failure).toBeInstanceOf(ProviderError);
        expect(failure.message).toBe(CREDIT_USED_UP);
        expect(failure.retryable).toBe(false);
        expect(provider.requests).toHaveLength(1);

        // On a key of the owner's own it is the gateway's refusal, as said.
        provider.queue(spent);
        const own = await adapterFor(connection(kind))
            .complete(request)
            .catch(e => e);
        expect(own.message).toMatch(
            /^The model gateway refused the request: Budget exceeded/,
        );
    });

    it("sends the connection's gateway key with every request", async () => {
        provider.queue({ text: "fine" }, { text: "fine" });
        await adapterFor({ ...connection(kind), keyId: "key-123" }).complete(
            request,
        );
        await adapterFor({ ...connection(kind), keyId: null }).complete(
            request,
        );
        expect(provider.requests[0]!.headers["x-bf-api-key-id"]).toBe(
            "key-123",
        );
        expect(
            provider.requests[1]!.headers["x-bf-api-key-id"],
        ).toBeUndefined();
    });

    it("gives up after its retries on a provider that stays down", async () => {
        const down = {
            error: {
                status: 503,
                message: "down",
                headers: { "retry-after-ms": "1" },
            },
        };
        provider.queue(down, down, down, down, down);
        const failure = await adapterFor(connection(kind))
            .complete(request)
            .catch(e => e);
        expect(failure).toBeInstanceOf(ProviderError);
        expect(failure.retryable).toBe(true);
        expect(provider.requests).toHaveLength(4);
    });
});

describe("withRetries", () => {
    it("backs off between attempts and stops on an error that is not retryable", async () => {
        const waits: number[] = [];
        let calls = 0;
        const result = await withRetries(
            async () => {
                if (++calls < 3)
                    throw new ProviderError("busy", { retryable: true });
                return "ok";
            },
            { wait: async ms => void waits.push(ms) },
        );
        expect(result).toBe("ok");
        expect(waits).toEqual([500, 1500]);

        calls = 0;
        await expect(
            withRetries(async () => {
                calls++;
                throw new ProviderError("bad request", { status: 400 });
            }),
        ).rejects.toThrow("bad request");
        expect(calls).toBe(1);
    });

    it("treats a very long retry-after as an outage", async () => {
        let calls = 0;
        await expect(
            withRetries(async () => {
                calls++;
                throw new ProviderError("come back tomorrow", {
                    retryable: true,
                    retryAfterMs: 3_600_000,
                });
            }),
        ).rejects.toThrow("come back tomorrow");
        expect(calls).toBe(1);
    });
});

describe("validateInput", () => {
    const schema = lookTool.inputSchema;
    it("accepts what fits and names what does not", () => {
        expect(validateInput(schema, { at: "x" })).toBeNull();
        expect(validateInput(schema, {})).toBe("input.at is required");
        expect(validateInput(schema, { at: 3 })).toBe(
            "input.at must be a string",
        );
        expect(
            validateInput(
                {
                    type: "array",
                    items: { type: "integer", minimum: 0 },
                    minItems: 1,
                },
                [1, -1],
            ),
        ).toBe("input[1] must be at least 0");
        expect(validateInput({ type: "string", enum: ["a", "b"] }, "c")).toBe(
            'input must be one of "a", "b"',
        );
    });
});

describe.each<ProviderKind>(["openai"])("the loop on %s", kind => {
    type Answer = { answer: string };
    const seenByTools: string[] = [];
    const tools = (): AgentTool<Answer>[] => [
        {
            def: lookTool,
            async run(input) {
                seenByTools.push(String(input.at));
                const content: ContentPart[] = [
                    text(`You see the ${String(input.at)}.`),
                    { type: "image", mediaType: "image/png", data: png },
                ];
                return { content, title: `Looked at the ${String(input.at)}` };
            },
        },
        {
            def: {
                name: "finish",
                description: "Ends the job.",
                inputSchema: {
                    type: "object",
                    properties: { answer: { type: "string" } },
                    required: ["answer"],
                    additionalProperties: false,
                },
            },
            async run(input) {
                if (input.answer === "wrong")
                    return {
                        content: [text("Not accepted: try again.")],
                        isError: true,
                        title: "Rejected",
                    };
                return {
                    content: [text("ok")],
                    result: { answer: String(input.answer) },
                    title: "Finished",
                };
            },
        },
    ];
    const start = (
        limits = { maxSteps: 6, wallClockMs: 20_000 },
        onTool?: Parameters<typeof runAgent<Answer>>[0]["onTool"],
    ) =>
        runAgent<Answer>({
            adapter: adapterFor(connection(kind)),
            system: "Test system prompt.",
            tools: tools(),
            first: [text("Go.")],
            limits,
            finishHint: "call finish",
            ...(onTool ? { onTool } : {}),
        });

    beforeEach(() => {
        seenByTools.length = 0;
    });

    it("runs tools until the terminal tool accepts, counting tokens per step", async () => {
        provider.queue(
            {
                calls: [{ name: "look", input: { at: "header" } }],
                usage: { input: 100, output: 10 },
            },
            {
                calls: [{ name: "finish", input: { answer: "wrong" } }],
                usage: { input: 200, output: 20 },
            },
            {
                calls: [{ name: "finish", input: { answer: "42" } }],
                usage: { input: 300, output: 30 },
            },
        );
        const events: {
            name: string;
            error: boolean;
            input: number;
            output: number;
        }[] = [];
        const run = await start(undefined, async e => {
            events.push({
                name: e.name,
                error: e.outcome.isError ?? false,
                input: e.usage.inputTokens,
                output: e.usage.outputTokens,
            });
        });

        expect(run).toMatchObject({
            result: { answer: "42" },
            stopped: "done",
            steps: 3,
            usage: { inputTokens: 600, outputTokens: 60 },
            model: "test-model",
        });
        expect(seenByTools).toEqual(["header"]);
        expect(events).toEqual([
            { name: "look", error: false, input: 100, output: 10 },
            { name: "finish", error: true, input: 200, output: 20 },
            { name: "finish", error: false, input: 300, output: 30 },
        ]);
        // The tool's text and image went back to the model on the next turn.
        expect(provider.requests[1]!.lastText).toContain("You see the header.");
        expect(provider.requests[1]!.raw).toContain(png.toString("base64"));
        // The rejection went back as an error the model could act on.
        expect(provider.requests[2]!.lastText).toContain(
            "Not accepted: try again.",
        );
    });

    it("sends bad arguments and unknown tools back as errors, without running anything", async () => {
        provider.queue(
            { calls: [{ name: "look", input: { where: "header" } }] },
            { calls: [{ name: "teleport", input: {} }] },
            { calls: [{ name: "finish", input: { answer: "ok" } }] },
        );
        const run = await start();
        expect(run.result).toEqual({ answer: "ok" });
        expect(seenByTools).toEqual([]);
        expect(provider.requests[1]!.lastText).toContain(
            "Invalid arguments: input.at is required",
        );
        expect(provider.requests[2]!.lastText).toContain(
            'There is no tool called "teleport"',
        );
    });

    it("nudges a model that answers in prose, then gives up", async () => {
        provider.queue(
            { text: "I think the answer is 42." },
            { text: "Really, 42." },
            { text: "42, as I said." },
        );
        const run = await start();
        expect(run).toMatchObject({
            result: null,
            stopped: "no_tool_call",
            steps: 3,
        });
        expect(provider.requests[1]!.lastText).toContain(
            "only tool calls count. If the work is done, call finish now.",
        );
    });

    it("stops at the step limit, having warned the model on its last turn", async () => {
        const again = { calls: [{ name: "look", input: { at: "page" } }] };
        provider.queue(again, again, again, again);
        const run = await start({ maxSteps: 3, wallClockMs: 20_000 });
        expect(run).toMatchObject({
            result: null,
            stopped: "step_limit",
            steps: 3,
        });
        expect(provider.requests).toHaveLength(3);
        expect(provider.requests[2]!.lastText).toContain(
            "You have one turn left. Now call finish",
        );
    });

    it("stops at the wall-clock limit", async () => {
        const slow: AgentTool<Answer> = {
            def: lookTool,
            async run() {
                await new Promise(resolve => setTimeout(resolve, 400));
                return { content: [text("slow")] };
            },
        };
        provider.queue(
            { calls: [{ name: "look", input: { at: "a" } }] },
            { calls: [{ name: "look", input: { at: "b" } }] },
        );
        const run = await runAgent<Answer>({
            adapter: adapterFor(connection(kind)),
            system: "s",
            tools: [slow],
            first: [text("Go.")],
            limits: { maxSteps: 10, wallClockMs: 250 },
            finishHint: "call finish",
        });
        expect(run).toMatchObject({ result: null, stopped: "time_limit" });
    });

    it("lets a provider failure through", async () => {
        provider.queue({
            error: { status: 400, message: "model not supported" },
        });
        await expect(start()).rejects.toBeInstanceOf(ProviderError);
    });
});
