/**
 * The providers a person can add a key for, and what each one asks for. Used
 * by the add/edit form in the browser and by the server, which turns the
 * answers into a Bifrost provider key (see `keyBody` in service.ts).
 *
 * Every provider here is one the Bifrost gateway supports for chat with
 * tools (Bifrost v2.6, `docs/providers/supported-providers/overview.mdx`).
 * Left out on purpose:
 *   - providers without chat (ElevenLabs, Soniox, Runway, Runware, MachGen,
 *     TypeSafe), which the Agent cannot use;
 *   - GitHub Copilot (a device sign-in, not a key) and SageMaker (endpoint
 *     configuration per model), which do not fit a key form;
 *   - credentials that would run on the gateway's own identity: Azure
 *     default credentials, Bedrock IAM roles and Vertex application-default
 *     or external-account credentials. A person always brings their own.
 *
 * Azure has no API version setting: Bifrost v2 speaks Azure's v1 API, which
 * has none, and drops the field.
 *
 * Secret fields are sent to Bifrost and never stored by us or shown again.
 * The others are kept on the connection (`settings`) for display.
 */

export type FieldKind = "text" | "url" | "secret" | "json";

export type ProviderField = {
    /** Where the value goes in the Bifrost key: `<config>.<name>`, or a top-level setting. */
    name: string;
    label: string;
    kind: FieldKind;
    required: boolean;
    placeholder?: string;
    help?: string;
};

export type ProviderSpec = {
    id: string;
    label: string;
    /** The Bifrost key's `<provider>_key_config`, when the provider has one. */
    config?: string;
    /** How the API key field is shown, or null when the provider has none. */
    key: { label: string; required: boolean; placeholder?: string } | null;
    fields: ProviderField[];
    /** Model name → deployment (Azure) or inference profile (Bedrock). */
    deployments?: { label: string; help: string };
    /** Shown under the provider picker. */
    note?: string;
};

const apiKey = (placeholder?: string) => ({
    label: "API key",
    required: true,
    placeholder,
});

/** Every provider this app knows how to ask for; see EXCLUDED_PROVIDERS. */
const ALL_PROVIDERS: ProviderSpec[] = [
    { id: "openai", label: "OpenAI", key: apiKey("sk-..."), fields: [] },
    {
        id: "anthropic",
        label: "Anthropic",
        key: apiKey("sk-ant-..."),
        fields: [],
    },
    {
        id: "azure",
        label: "Azure OpenAI",
        config: "azure_key_config",
        key: apiKey(),
        fields: [
            {
                name: "endpoint",
                label: "Endpoint",
                kind: "url",
                required: true,
                placeholder: "https://my-resource.openai.azure.com",
            },
        ],
        deployments: {
            label: "Deployments",
            help: "One per line: model = deployment name, e.g. gpt-4o = my-gpt4o.",
        },
    },
    {
        id: "bedrock",
        label: "AWS Bedrock",
        config: "bedrock_key_config",
        key: {
            label: "Bedrock API key",
            required: false,
            placeholder: "Or use an access key below",
        },
        fields: [
            {
                name: "access_key",
                label: "Access key ID",
                kind: "secret",
                required: false,
            },
            {
                name: "secret_key",
                label: "Secret access key",
                kind: "secret",
                required: false,
            },
            {
                name: "session_token",
                label: "Session token",
                kind: "secret",
                required: false,
                help: "Only for temporary credentials.",
            },
            {
                name: "region",
                label: "Region",
                kind: "text",
                required: true,
                placeholder: "us-east-1",
            },
        ],
        deployments: {
            label: "Inference profiles",
            help: "Optional. One per line: model = inference profile ID or ARN.",
        },
        note: "Give a Bedrock API key, or an access key ID and secret access key.",
    },
    {
        id: "bedrock_mantle",
        label: "AWS Bedrock Mantle",
        config: "bedrock_mantle_key_config",
        key: null,
        fields: [
            {
                name: "access_key",
                label: "Access key ID",
                kind: "secret",
                required: true,
            },
            {
                name: "secret_key",
                label: "Secret access key",
                kind: "secret",
                required: true,
            },
            {
                name: "session_token",
                label: "Session token",
                kind: "secret",
                required: false,
            },
            {
                name: "region",
                label: "Region",
                kind: "text",
                required: true,
                placeholder: "us-east-1",
            },
        ],
    },
    {
        id: "vertex",
        label: "Google Vertex AI",
        config: "vertex_key_config",
        key: null,
        fields: [
            {
                name: "project_id",
                label: "Project ID",
                kind: "text",
                required: true,
            },
            {
                name: "region",
                label: "Region",
                kind: "text",
                required: true,
                placeholder: "us-central1",
            },
            {
                name: "auth_credentials",
                label: "Service account key (JSON)",
                kind: "json",
                required: true,
                help: "The JSON key file of a service account that may use Vertex AI.",
            },
        ],
    },
    { id: "gemini", label: "Google Gemini", key: apiKey(), fields: [] },
    { id: "mistral", label: "Mistral", key: apiKey(), fields: [] },
    { id: "groq", label: "Groq", key: apiKey("gsk_..."), fields: [] },
    { id: "cohere", label: "Cohere", key: apiKey(), fields: [] },
    { id: "cerebras", label: "Cerebras", key: apiKey(), fields: [] },
    { id: "fireworks", label: "Fireworks", key: apiKey(), fields: [] },
    { id: "xai", label: "xAI", key: apiKey("xai-..."), fields: [] },
    {
        id: "openrouter",
        label: "OpenRouter",
        key: apiKey("sk-or-..."),
        fields: [],
    },
    { id: "deepseek", label: "DeepSeek", key: apiKey(), fields: [] },
    {
        id: "perplexity",
        label: "Perplexity",
        key: apiKey("pplx-..."),
        fields: [],
    },
    {
        id: "huggingface",
        label: "Hugging Face",
        key: apiKey("hf_..."),
        fields: [],
    },
    { id: "nebius", label: "Nebius", key: apiKey(), fields: [] },
    { id: "parasail", label: "Parasail", key: apiKey(), fields: [] },
    { id: "baseten", label: "Baseten", key: apiKey(), fields: [] },
    { id: "byteplus", label: "BytePlus", key: apiKey(), fields: [] },
    { id: "minimax", label: "MiniMax", key: apiKey(), fields: [] },
    { id: "sarvam", label: "Sarvam AI", key: apiKey(), fields: [] },
    { id: "kimchi", label: "Kimchi", key: apiKey(), fields: [] },
    { id: "wafer", label: "Wafer", key: apiKey(), fields: [] },
    { id: "replicate", label: "Replicate", key: apiKey("r8_..."), fields: [] },
    {
        id: "cloudflare",
        label: "Cloudflare Workers AI",
        config: "cloudflare_key_config",
        key: { label: "API token", required: true },
        fields: [
            {
                name: "account_id",
                label: "Account ID",
                kind: "text",
                required: true,
            },
        ],
    },
    {
        id: "databricks",
        label: "Databricks",
        config: "databricks_key_config",
        key: { label: "Access token", required: true, placeholder: "dapi..." },
        fields: [
            {
                name: "workspace_url",
                label: "Workspace URL",
                kind: "url",
                required: true,
                placeholder: "https://my-workspace.cloud.databricks.com",
            },
        ],
    },
    {
        id: "ollama",
        label: "Ollama",
        config: "ollama_key_config",
        key: { label: "API key", required: false, placeholder: "Optional" },
        fields: [
            {
                name: "url",
                label: "Server URL",
                kind: "url",
                required: true,
                placeholder: "https://ollama.example.com",
            },
        ],
    },
    {
        id: "vllm",
        label: "vLLM",
        config: "vllm_key_config",
        key: { label: "API key", required: false, placeholder: "Optional" },
        fields: [
            {
                name: "url",
                label: "Server URL",
                kind: "url",
                required: true,
                placeholder: "https://vllm.example.com",
            },
            {
                name: "model_name",
                label: "Model name",
                kind: "text",
                required: false,
                help: "The model this server serves, when it serves one.",
            },
        ],
    },
    {
        id: "sgl",
        label: "SGLang",
        config: "sgl_key_config",
        key: { label: "API key", required: false, placeholder: "Optional" },
        fields: [
            {
                name: "url",
                label: "Server URL",
                kind: "url",
                required: true,
                placeholder: "https://sglang.example.com",
            },
        ],
    },
];

/**
 * Providers left out of the Connections page on purpose: not offered, not
 * accepted by the API. The one place to change which ones people can add.
 * Self-hosted servers (Ollama, vLLM, SGLang) can still be added as an
 * OpenAI-compatible endpoint.
 */
export const EXCLUDED_PROVIDERS = new Set([
    "perplexity",
    "huggingface",
    "nebius",
    "parasail",
    "baseten",
    "byteplus",
    "minimax",
    "sarvam",
    "kimchi",
    "wafer",
    "replicate",
    "cloudflare",
    "databricks",
    "ollama",
    "vllm",
    "sgl",
]);

/** The providers a person can add a key for. */
export const PROVIDERS: ProviderSpec[] = ALL_PROVIDERS.filter(
    p => !EXCLUDED_PROVIDERS.has(p.id),
);

/** The two custom-endpoint choices: any server that speaks one of these APIs. */
export const ENDPOINTS = [
    {
        id: "openai",
        label: "OpenAI-compatible endpoint",
        description:
            "Any server that speaks the Chat Completions API: a gateway, or a model you host yourself.",
        placeholder: "https://gateway.example.com/v1",
    },
    {
        id: "anthropic",
        label: "Anthropic-compatible endpoint",
        description: "Any server that speaks the Anthropic Messages API.",
        placeholder: "https://gateway.example.com",
    },
] as const;

export function providerSpec(id: string): ProviderSpec | undefined {
    return PROVIDERS.find(p => p.id === id);
}

/** The provider's name, or the endpoint kind for a connection with a base URL. */
export function providerLabel(kind: string, baseUrl: string | null): string {
    if (kind === "wts") return "WatchThatSite credit";
    if (baseUrl) return ENDPOINTS.find(e => e.id === kind)?.label ?? kind;
    return providerSpec(kind)?.label ?? kind;
}

/** Logos shipped in `public/images/ai-providers`. */
const LOGOS = new Set([
    "anthropic",
    "azure",
    "bedrock",
    "cerebras",
    "cohere",
    "deepseek",
    "fireworks",
    "gemini",
    "groq",
    "mistral",
    "openai",
    "openrouter",
    "vertex",
    "xai",
]);

export function providerLogo(
    kind: string,
    baseUrl: string | null,
): string | null {
    if (baseUrl) return null;
    // The WatchThatSite credit wears the app's own mark.
    if (kind === "wts") return "/images/watchthatsite.svg";
    const id = kind === "bedrock_mantle" ? "bedrock" : kind;
    if (!LOGOS.has(id)) return null;
    return `/images/ai-providers/${id}.webp`;
}

/** Deployments typed as "model = deployment" lines, as a map. */
export function parseDeployments(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const [model, ...rest] = line.split("=");
        const target = rest.join("=").trim();
        if (model?.trim() && target) out[model.trim()] = target;
    }
    return out;
}

export function formatDeployments(map: Record<string, string>): string {
    return Object.entries(map)
        .map(([model, target]) => `${model} = ${target}`)
        .join("\n");
}

function host(url: unknown): string {
    if (typeof url !== "string") return "";
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * The non-secret settings in a few words, for the table: "eastus · 3
 * deployments" for Azure, "us-east-1" for Bedrock, the URL of
 * a custom endpoint. Empty when there is nothing to show.
 */
export function settingsSummary(
    kind: string,
    baseUrl: string | null,
    settings: Record<string, unknown>,
): string {
    if (baseUrl) return baseUrl;
    const parts: string[] = [];
    const str = (key: string) =>
        typeof settings[key] === "string" && settings[key] ?
            (settings[key] as string)
        :   null;
    const deployments =
        settings.deployments && typeof settings.deployments === "object" ?
            Object.keys(settings.deployments as object).length
        :   0;
    switch (kind) {
        case "azure": {
            const resource = host(settings.endpoint).split(".")[0];
            if (resource) parts.push(resource);
            if (deployments)
                parts.push(
                    `${deployments} ${deployments === 1 ? "deployment" : "deployments"}`,
                );
            break;
        }
        case "bedrock":
        case "bedrock_mantle":
            if (str("region")) parts.push(str("region")!);
            if (deployments)
                parts.push(
                    `${deployments} inference ${deployments === 1 ? "profile" : "profiles"}`,
                );
            break;
        case "vertex":
            for (const key of ["project_id", "region"]) {
                if (str(key)) parts.push(str(key)!);
            }
            break;
        case "cloudflare":
            if (str("account_id")) parts.push(str("account_id")!);
            break;
        case "databricks":
            if (str("workspace_url")) parts.push(host(settings.workspace_url));
            break;
        default:
            if (str("url")) parts.push(str("url")!);
            if (str("model_name")) parts.push(str("model_name")!);
    }
    return parts.join(" · ");
}

/** A name to start the form with: "OpenAI", "Azure OpenAI (eastus)". */
export function defaultName(
    kind: string,
    baseUrl: string,
    settings: Record<string, string>,
): string {
    if (baseUrl) {
        const h = host(baseUrl.trim());
        return h || (ENDPOINTS.find(e => e.id === kind)?.label ?? "");
    }
    const label = providerSpec(kind)?.label ?? kind;
    const detail = settingsSummary(kind, null, settings).split(" · ")[0];
    return detail ? `${label} (${detail})` : label;
}
