import type { ResolvedConnection } from "../../store/store.js";
import type { ProviderAdapter } from "../types.js";
import { createOpenAIAdapter } from "./openai.js";

export { ProviderError } from "./errors.js";

/**
 * The adapter for a connection. Every connection is reached through the
 * Bifrost gateway's OpenAI-compatible API, which translates Chat Completions
 * (tools, `tool_choice`, images) for every provider it supports, Anthropic,
 * Bedrock, Vertex and Gemini included.
 */
export function adapterFor(connection: ResolvedConnection): ProviderAdapter {
    return createOpenAIAdapter(connection);
}
