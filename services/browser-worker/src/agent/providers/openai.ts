import OpenAI from "openai";
import type { ResolvedConnection } from "../../store/store.js";
import type {
    AgentMessage,
    ContentPart,
    ModelRequest,
    ModelTurn,
    ProviderAdapter,
    StopReason,
    ToolCall,
} from "../types.js";
import {
    budgetError,
    gatewayHeaders,
    parseRetryAfter,
    ProviderError,
    retryableStatus,
    scrubKey,
    withRetries,
} from "./errors.js";

const requestTimeoutMs = 120_000;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type ChatRequest =
    OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

function userParts(parts: ContentPart[]): ChatPart[] {
    return parts.map(part =>
        part.type === "text" ?
            { type: "text", text: part.text }
        :   {
                type: "image_url",
                image_url: {
                    url: `data:${part.mediaType};base64,${part.data.toString("base64")}`,
                },
            },
    );
}

function renderMessage(message: AgentMessage): ChatMessage[] {
    if (message.role === "user") {
        return [{ role: "user", content: userParts(message.content) }];
    }
    if (message.role === "assistant") {
        if (message.raw && typeof message.raw === "object") {
            return [message.raw as ChatMessage];
        }
        return [
            {
                role: "assistant",
                content: message.text || null,
                ...(message.toolCalls.length > 0 ?
                    {
                        tool_calls: message.toolCalls.map(call => ({
                            id: call.id,
                            type: "function" as const,
                            function: {
                                name: call.name,
                                arguments: JSON.stringify(call.input ?? {}),
                            },
                        })),
                    }
                :   {}),
            },
        ];
    }

    // A Chat Completions tool message carries text only. Images a tool
    // returned follow in one user message, after every tool message of the
    // turn (the API wants those together), each labelled with its call.
    const out: ChatMessage[] = [];
    const images: ChatPart[] = [];
    for (const result of message.results) {
        const texts: string[] = [];
        let imageCount = 0;
        for (const part of result.content) {
            if (part.type === "text") texts.push(part.text);
            else imageCount++;
        }
        if (imageCount > 0) {
            texts.push(
                `(${imageCount} image${imageCount === 1 ? "" : "s"} from this tool follow in the next message, labelled ${result.name} ${result.callId}.)`,
            );
            images.push({
                type: "text",
                text: `Images returned by ${result.name} (${result.callId}):`,
            });
            images.push(
                ...userParts(result.content.filter(p => p.type === "image")),
            );
        }
        const body = texts.join("\n") || "(no output)";
        out.push({
            role: "tool",
            tool_call_id: result.callId,
            content: result.isError ? `Error: ${body}` : body,
        });
    }
    if (images.length > 0) out.push({ role: "user", content: images });
    return out;
}

/**
 * The Chat Completions request for one turn. Pure, so tests can check the
 * wire shape without a server.
 *
 * Chat Completions rather than the Responses API, because it is the one
 * endpoint every OpenAI-compatible provider offers. No `temperature` and no
 * token cap: current OpenAI models reject `temperature` and `max_tokens`, and
 * compatible servers disagree on the name of the cap.
 */
export function renderOpenAI(
    model: string,
    request: ModelRequest,
    opts: { noReasoning?: boolean; anyTool?: boolean } = {},
): ChatRequest {
    return {
        model,
        messages: [
            { role: "system", content: request.system },
            ...request.messages.flatMap(renderMessage),
        ],
        tools: request.tools.map(tool => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema as Record<string, unknown>,
            },
        })),
        // Every job ends through a tool, so a turn of plain prose is never
        // an answer. Requiring a tool call stops a model from "finishing" by
        // describing what it did instead of calling the tool that says so.
        ...(opts.anyTool === false ? {} : { tool_choice: "required" as const }),
        ...(opts.noReasoning ? { reasoning_effort: "none" as const } : {}),
    };
}

function stopReason(reason: string | null | undefined): StopReason {
    switch (reason) {
        case "tool_calls":
        case "function_call":
            return "tool_use";
        case "length":
            return "max_tokens";
        case "content_filter":
            return "refusal";
        default:
            return "end";
    }
}

export function readOpenAI(
    completion: OpenAI.Chat.Completions.ChatCompletion,
): ModelTurn {
    const choice = completion.choices[0];
    if (!choice) {
        throw new ProviderError("The provider returned no choices", {
            retryable: true,
        });
    }
    const toolCalls: ToolCall[] = [];
    for (const call of choice.message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        let input: unknown = {};
        let inputError: string | undefined;
        try {
            input = JSON.parse(call.function.arguments || "{}");
        } catch {
            inputError = "the arguments were not valid JSON";
        }
        toolCalls.push({
            id: call.id,
            name: call.function.name,
            input,
            ...(inputError ? { inputError } : {}),
        });
    }
    // Replay only what a request accepts: some servers add fields to the
    // reply (reasoning text, annotations) that they then reject as input.
    const raw: ChatMessage = {
        role: "assistant",
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls?.length ?
            { tool_calls: choice.message.tool_calls }
        :   {}),
    };
    const refused =
        typeof choice.message.refusal === "string" &&
        choice.message.refusal !== "";
    return {
        text: choice.message.content ?? choice.message.refusal ?? "",
        toolCalls,
        raw,
        stop:
            refused ? "refusal"
            : toolCalls.length > 0 ? "tool_use"
            : stopReason(choice.finish_reason),
        usage: {
            inputTokens: completion.usage?.prompt_tokens ?? 0,
            outputTokens: completion.usage?.completion_tokens ?? 0,
        },
        model: completion.model || "",
    };
}

function classify(
    error: unknown,
    connection: ResolvedConnection,
): ProviderError {
    const apiKey = connection.apiKey;
    if (error instanceof ProviderError) return error;
    if (error instanceof OpenAI.APIUserAbortError) {
        return new ProviderError("The model call was cancelled", {
            cause: error,
        });
    }
    if (error instanceof OpenAI.APIConnectionError) {
        return new ProviderError(
            scrubKey(
                `Could not reach the model provider: ${error.message}`,
                apiKey,
            ),
            { retryable: true, cause: error },
        );
    }
    if (error instanceof OpenAI.APIError) {
        const status = error.status ?? null;
        const said = (error.error as { message?: unknown } | undefined)
            ?.message;
        const spent = budgetError(
            status,
            typeof said === "string" ? said : error.message,
            connection,
            apiKey,
            error,
        );
        if (spent) return spent;
        const code = typeof error.code === "string" ? error.code : "";
        // An exhausted quota answers 429 but will not recover by waiting.
        const outOfQuota = /insufficient_quota|billing|spend_limit/.test(code);
        const prefix =
            error instanceof OpenAI.AuthenticationError ?
                "The provider rejected the API key"
            : error instanceof OpenAI.PermissionDeniedError ?
                "The API key is not allowed to use this model"
            : error instanceof OpenAI.NotFoundError ?
                "The provider does not know this model"
            : outOfQuota ? "The provider account is out of quota"
            : error instanceof OpenAI.RateLimitError ?
                "The provider is rate limiting this key"
            :   `The provider answered ${status ?? "with an error"}`;
        return new ProviderError(
            scrubKey(`${prefix}: ${error.message}`, apiKey),
            {
                status,
                retryable: !outOfQuota && retryableStatus(status),
                retryAfterMs: parseRetryAfter(error.headers),
                cause: error,
            },
        );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError(scrubKey(message, apiKey), { cause: error });
}

/**
 * Some reasoning models only accept function tools on Chat Completions with
 * reasoning switched off, and say so in a 400 that names `reasoning_effort`.
 */
function wantsNoReasoning(error: unknown): boolean {
    return (
        error instanceof OpenAI.BadRequestError &&
        (error.param === "reasoning_effort" ||
            /reasoning_effort/.test(error.message)) &&
        /'none'|"none"/.test(error.message)
    );
}

/**
 * Not every OpenAI-compatible server accepts `tool_choice: "required"`; one
 * that does not says so in a 400 that names `tool_choice`.
 */
function rejectsRequiredTool(error: unknown): boolean {
    return (
        error instanceof OpenAI.BadRequestError &&
        (error.param === "tool_choice" || /tool_choice/.test(error.message))
    );
}

/** An OpenAI-compatible Chat Completions API, through the official SDK. */
export function createOpenAIAdapter(
    connection: ResolvedConnection,
): ProviderAdapter {
    // Everything is passed explicitly so the SDK never reads OPENAI_*
    // variables (organization and project included). Retries are ours.
    const client = new OpenAI({
        apiKey: connection.apiKey,
        organization: null,
        project: null,
        baseURL: connection.baseUrl,
        defaultHeaders: gatewayHeaders(connection),
        maxRetries: 0,
        timeout: requestTimeoutMs,
    });
    // Learned from the provider's answers and kept for the job.
    let noReasoning = false;
    let anyTool = true;

    return {
        model: connection.model,
        complete(request, signal) {
            const send = async () => {
                const body = renderOpenAI(connection.model, request, {
                    noReasoning,
                    anyTool,
                });
                return readOpenAI(
                    await client.chat.completions.create(
                        body,
                        signal ? { signal } : {},
                    ),
                );
            };
            return withRetries(
                async () => {
                    // Each rejected setting is dropped once and the request
                    // sent again, so at most two extra attempts.
                    for (;;) {
                        try {
                            return await send();
                        } catch (err) {
                            if (!noReasoning && wantsNoReasoning(err)) {
                                noReasoning = true;
                                continue;
                            }
                            if (anyTool && rejectsRequiredTool(err)) {
                                anyTool = false;
                                continue;
                            }
                            throw classify(err, connection);
                        }
                    }
                },
                { signal },
            );
        },
    };
}
