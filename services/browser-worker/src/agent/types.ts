
/**
 * The one message and tool format the agent loop speaks. Each provider
 * adapter renders it into its own wire format and reads replies back into it.
 */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type TextPart = { type: "text"; text: string };
export type ImagePart = {
    type: "image";
    mediaType: ImageMediaType;
    data: Buffer;
};
export type ContentPart = TextPart | ImagePart;

export const text = (value: string): TextPart => ({
    type: "text",
    text: value,
});

export interface ToolCall {
    id: string;
    name: string;
    /** The parsed arguments; `{}` when they could not be parsed. */
    input: unknown;
    /** Set when the model's arguments were not valid JSON. */
    inputError?: string;
}

export interface ToolResult {
    callId: string;
    name: string;
    content: ContentPart[];
    isError: boolean;
}

export type AgentMessage =
    | { role: "user"; content: ContentPart[] }
    | {
          role: "assistant";
          text: string;
          toolCalls: ToolCall[];
          /**
           * The provider's own form of this turn, replayed as is by the
           * adapter that produced it (Anthropic thinking blocks must go back
           * unchanged; OpenAI keeps the original argument strings).
           */
          raw: unknown;
      }
    | { role: "tool"; results: ToolResult[] };

export interface ToolDef {
    name: string;
    description: string;
    /** JSON Schema of the arguments: an object with `properties`. */
    inputSchema: JsonSchema;
}

export type JsonSchema = {
    type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchema;
    enum?: (string | number)[];
    minItems?: number;
    maxItems?: number;
    minimum?: number;
    maximum?: number;
};

export interface ModelRequest {
    system: string;
    tools: ToolDef[];
    messages: AgentMessage[];
}

export type StopReason = "tool_use" | "end" | "max_tokens" | "refusal";

export interface Usage {
    inputTokens: number;
    outputTokens: number;
}

export interface ModelTurn {
    text: string;
    toolCalls: ToolCall[];
    raw: unknown;
    stop: StopReason;
    usage: Usage;
    /** The model that answered, as the provider reports it. */
    model: string;
}

export interface ProviderAdapter {
    model: string;
    /** One model turn. Retries rate limits and outages; throws ProviderError. */
    complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelTurn>;
}
