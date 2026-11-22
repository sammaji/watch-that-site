import "server-only";

import { PUBLIC_BASE_URLS, type EndpointKind } from "@watchthatsite/types";

/**
 * Helpers around the model lists the gateway gives back for a key, and the
 * custom-endpoint base URL.
 */

/**
 * Removes the key from text that came from somewhere else (a provider's
 * error body, a thrown error) before it is shown, stored or logged.
 */
export function scrubKey(text: string, apiKey: string): string {
    const key = apiKey.trim();
    if (key.length < 4) return text;
    return text.split(key).join("[key removed]");
}

/**
 * A custom endpoint's base URL as stored: trimmed, without a trailing slash, and `null` when
 * it is the provider's public endpoint. An Anthropic-compatible base is the
 * address before `/v1`, so a trailing `/v1` is dropped.
 */
export function normalizeBaseUrl(
    kind: EndpointKind,
    raw: string | null | undefined,
): string | null {
    let base = (raw ?? "").trim().replace(/\/+$/, "");
    if (kind === "anthropic") base = base.replace(/\/v1$/, "");
    if (!base || base === PUBLIC_BASE_URLS[kind]) return null;
    return base;
}

// Ids that name something other than a chat model on OpenAI-style lists.
const NOT_CHAT =
    /embed|whisper|tts|dall-e|moderation|transcri|realtime|audio|image|sora|babbage|davinci|rerank/i;

/**
 * The models to switch on for a new connection: everything listed, minus the
 * ids that are plainly not chat models (embeddings, speech, images). Those
 * stay available in the models editor.
 */
export function chatModels(listed: string[]): string[] {
    const chat = listed.filter(id => !NOT_CHAT.test(id));
    return chat.length > 0 ? chat : listed;
}

/** `gpt-5.1` style ids: a whole model family, not a dated or sized variant. */
const OPENAI_FLAGSHIP = /^gpt-(\d+(?:\.\d+)?)$/;

/**
 * A reasonable first default: on Anthropic the newest Sonnet (the list comes
 * newest first), on OpenAI the highest plain `gpt-N` id, otherwise the first
 * model. The owner can change it.
 */
export function pickDefaultModel(
    kind: string,
    models: string[],
): string | null {
    if (models.length === 0) return null;
    if (kind === "anthropic") {
        return models.find(id => id.includes("sonnet")) ?? models[0]!;
    }
    const flagships = models
        .map(id => ({ id, version: Number(OPENAI_FLAGSHIP.exec(id)?.[1]) }))
        .filter(m => Number.isFinite(m.version))
        .sort((a, b) => b.version - a.version);
    return flagships[0]?.id ?? models[0]!;
}
