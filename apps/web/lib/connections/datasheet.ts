import "server-only";

/**
 * Which listed models the Agent can use, from Bifrost's public datasheets.
 *
 * A provider's model listing has everything a key can reach: embeddings,
 * speech, image generators, moderation, retired models. The Agent needs a
 * model it can hold a conversation with that calls tools and reads images
 * (screenshots). Bifrost publishes what each model supports:
 *
 *   getbifrost.ai/datasheet                   capabilities and modes
 *   getbifrost.ai/datasheet/model-parameters  the request parameters a model takes
 *
 * Both are fetched once and kept for a few hours. When neither can be read,
 * nothing is filtered: the owner still sees every listed model rather than
 * none.
 */

const DATASHEET_URL = "https://getbifrost.ai/datasheet";
const PARAMETERS_URL = "https://getbifrost.ai/datasheet/model-parameters";
const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;

type DatasheetEntry = {
    provider?: string;
    mode?: string;
    supports_function_calling?: boolean;
    supports_tool_choice?: boolean;
    supports_vision?: boolean;
    supports_image_input?: boolean;
    is_deprecated?: boolean;
    deprecation_date?: string;
};

type ParametersEntry = {
    model_parameters?: { id?: string }[];
};

type Sheets = {
    models: Record<string, DatasheetEntry>;
    parameters: Record<string, ParametersEntry>;
};

/** Modes the Agent can converse with; everything else (embeddings, audio, images) is out. */
const CONVERSATION_MODES = new Set(["chat", "responses", "decisions"]);

/** Where the datasheet names a provider differently from Bifrost's provider ids. */
const SHEET_PROVIDER: Record<string, string> = {
    vertex: "vertex_ai",
    fireworks: "fireworks_ai",
};

let cached: { at: number; sheets: Sheets } | null = null;
let loading: Promise<Sheets | null> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return (await response.json()) as T;
}

async function load(): Promise<Sheets | null> {
    try {
        const [models, parameters] = await Promise.all([
            fetchJson<Sheets["models"]>(DATASHEET_URL),
            fetchJson<Sheets["parameters"]>(PARAMETERS_URL).catch(() => ({})),
        ]);
        cached = { at: Date.now(), sheets: { models, parameters } };
        return cached.sheets;
    } catch (error) {
        console.error(
            "[connections] could not read the model datasheet:",
            error instanceof Error ? error.message : "unknown error",
        );
        // A stale copy is better than no filtering.
        return cached?.sheets ?? null;
    }
}

async function sheets(): Promise<Sheets | null> {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.sheets;
    loading ??= load().finally(() => {
        loading = null;
    });
    return loading;
}

/**
 * The datasheet entry for a model as a provider lists it. Entries are keyed
 * `provider/model` or by the bare model id with a `provider` field; a model
 * reached through an OpenAI-compatible gateway (OpenRouter style) may carry
 * its maker in its id (`anthropic/claude-…`), which is tried as a key too.
 */
function find<T>(
    table: Record<string, T & { provider?: string }>,
    provider: string,
    model: string,
): (T & { provider?: string }) | null {
    const sheetProvider = SHEET_PROVIDER[provider] ?? provider;
    const candidates = [
        `${sheetProvider}/${model}`,
        `${provider}/${model}`,
        model,
    ];
    for (const key of candidates) {
        const entry = table[key];
        if (!entry) continue;
        if (key === model && entry.provider && model.indexOf("/") === -1) {
            // A bare id belongs to the provider it names.
            if (
                entry.provider !== sheetProvider &&
                entry.provider !== provider
            ) {
                continue;
            }
        }
        return entry;
    }
    return null;
}

function retired(entry: DatasheetEntry, today: string): boolean {
    if (entry.is_deprecated) return true;
    return !!entry.deprecation_date && entry.deprecation_date <= today;
}

/**
 * Whether the Agent can use a model: `true` or `false` when the datasheet
 * knows it, `null` when it does not (a deployment name, a fine-tune, a model
 * newer than the datasheet), in which case the caller keeps it.
 */
function agentCapable(
    s: Sheets,
    provider: string,
    model: string,
    today: string,
): boolean | null {
    const entry = find(s.models, provider, model);
    if (!entry) return null;
    if (entry.mode && !CONVERSATION_MODES.has(entry.mode)) return false;
    if (retired(entry, today)) return false;
    if (entry.supports_function_calling === false) return false;
    if (
        entry.supports_vision === false &&
        entry.supports_image_input !== true
    ) {
        return false;
    }
    // The parameters sheet lists what a request may carry; a model whose
    // list is known and has no tools cannot run the Agent's loop.
    const params = find(s.parameters, provider, model)?.model_parameters;
    if (
        params &&
        params.length > 0 &&
        !params.some(p => p.id === "promptTools")
    ) {
        return false;
    }
    return true;
}

/**
 * The models from a provider's listing that the Agent can use. `provider` is
 * the kind of connection (`openai`, `groq`, `bedrock`, …; the base provider
 * for a custom endpoint) and `models` are bare model ids. Unknown models are
 * kept; known ones that cannot converse, call tools or read images are not.
 */
export async function agentModels(
    provider: string,
    models: string[],
): Promise<string[]> {
    const s = await sheets();
    if (!s) return models;
    const today = new Date().toISOString().slice(0, 10);
    return models.filter(m => agentCapable(s, provider, m, today) !== false);
}
