import { getPostgrestClient } from "@watchthatsite/auth/postgrest";

export type JsonSchemaStringProp = {
    type: "string";
    title?: string;
    description?: string;
    format?: string;
    pattern?: string;
};

export type JsonSchemaArrayProp = {
    type: "array";
    title?: string;
    description?: string;
    minItems?: number;
    maxItems?: number;
    items?: {
        type: "object";
        required?: string[];
        properties?: Record<string, JsonSchemaStringProp>;
    };
};

export type JsonSchemaProp = JsonSchemaStringProp | JsonSchemaArrayProp;

export type JsonSchema = {
    type: "object";
    required?: string[];
    properties?: Record<string, JsonSchemaProp>;
};

/** One setup instruction; `link` is a page the step sends the person to. */
export type SetupStep = {
    text: string;
    link?: { href: string; label: string };
};

export type ConfigVariant = {
    label: string;
    description?: string;
    /** How to get what the form asks for, in order. */
    steps?: SetupStep[];
    installAction?: "discord_bot" | "telegram_bot";
    schema: JsonSchema;
};

export type NotificationChannel = {
    id: string;
    name: string;
    description: string;
    icon: string;
    config_schema: JsonSchema;
    config_variants?: Record<string, ConfigVariant>;
};

/**
 * Hosts that local end-to-end sinks run on (comma-separated, e.g.
 * "localhost,127.0.0.1"). For these hosts only, the Slack, Discord and
 * webhook URL fields accept any http(s) URL. Mirrors the notifications
 * service's NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS; unset in production.
 */
const INSECURE_WEBHOOK_HOSTS = (
    process.env.NEXT_PUBLIC_NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS ?? ""
)
    .split(",")
    .map(h => h.trim())
    .filter(Boolean);

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Widens a URL pattern to also accept the insecure local hosts, if any. */
function withInsecureHosts(pattern: string): string {
    if (INSECURE_WEBHOOK_HOSTS.length === 0) return pattern;
    const hosts = INSECURE_WEBHOOK_HOSTS.map(escapeRegExp).join("|");
    return `(?:${pattern})|^https?://(?:${hosts})(?::[0-9]+)?(?:[/?#].*)?$`;
}

const WEBHOOK_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/></svg>',
)}`;

export const NOTIFICATION_CHANNELS: NotificationChannel[] = [
    {
        id: "email",
        name: "Email",
        description: "Send notifications via email.",
        icon: "/images/channels/gmail.png",
        config_schema: {
            type: "object",
            required: ["recipients"],
            properties: {
                recipients: {
                    type: "array",
                    title: "Recipients",
                    description:
                        "Email addresses to send notifications to (max 10).",
                    minItems: 1,
                    maxItems: 10,
                    items: {
                        type: "object",
                        required: ["email"],
                        properties: {
                            email: {
                                type: "string",
                                title: "Email Address",
                                pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
                            },
                        },
                    },
                },
            },
        },
    },
    {
        id: "slack",
        name: "Slack",
        description:
            "Send notifications to Slack channels via incoming webhooks.",
        icon: "/images/channels/slack.svg",
        config_schema: {
            type: "object",
            required: ["webhooks"],
            properties: {
                webhooks: {
                    type: "array",
                    title: "Webhooks",
                    description: "Slack incoming webhook URLs.",
                    minItems: 1,
                    items: {
                        type: "object",
                        required: ["url"],
                        properties: {
                            url: {
                                type: "string",
                                title: "Webhook URL",
                                pattern: withInsecureHosts(
                                    "^https://hooks\\.slack\\.com/services/[A-Z0-9]{10,}/[A-Z0-9]{10,}/[A-Za-z0-9_-]{24,}$",
                                ),
                            },
                        },
                    },
                },
            },
        },
    },
    {
        id: "discord",
        name: "Discord",
        description:
            "Send notifications to Discord channels via webhooks or bots.",
        icon: "/images/channels/discord.svg",
        config_schema: { type: "object", properties: {} },
        config_variants: {
            webhook: {
                label: "Webhook",
                description: "Send via Discord webhook URLs.",
                steps: [
                    {
                        text: "In Discord, open the channel's settings (the gear next to its name) and go to Integrations → Webhooks → New Webhook.",
                    },
                    {
                        text: 'Name it (for example "WatchThatSite"), check the channel it posts to, then press Copy Webhook URL.',
                    },
                    {
                        text: "Paste the URL below. Add one webhook per channel you want notified.",
                    },
                ],
                schema: {
                    type: "object",
                    required: ["webhooks"],
                    properties: {
                        webhooks: {
                            type: "array",
                            title: "Webhooks",
                            minItems: 1,
                            items: {
                                type: "object",
                                required: ["url"],
                                properties: {
                                    url: {
                                        type: "string",
                                        title: "Webhook URL",
                                        description:
                                            "Discord webhook URL (https://discord.com/api/webhooks/...).",
                                        pattern: withInsecureHosts(
                                            "^https://discord\\.com/api/webhooks/[0-9]{17,19}/[A-Za-z0-9_-]{60,}$",
                                        ),
                                    },
                                },
                            },
                        },
                    },
                },
            },
            bot_token: {
                label: "Bot Token",
                description: "Use your own Discord bot token.",
                steps: [
                    {
                        text: "Create an application, open its Bot page and press Reset Token. Copy the token; Discord shows it once.",
                        link: {
                            href: "https://discord.com/developers/applications",
                            label: "Discord Developer Portal",
                        },
                    },
                    {
                        text: 'Under OAuth2 → URL Generator, tick the "bot" scope and the Send Messages, Embed Links and Attach Files permissions. Open the generated URL and add the bot to your server.',
                    },
                    {
                        text: 'In Discord, turn on Developer Mode: User Settings → Advanced → Developer Mode. It adds the "Copy … ID" items used below.',
                    },
                    {
                        text: "Right-click each channel or thread the bot should post in → Copy Channel ID, and add it under Channels. The bot needs permission to see and post there.",
                    },
                    {
                        text: "For direct messages, right-click a person → Copy User ID and add it under Direct Messages. They must share a server with your bot.",
                    },
                    {
                        text: "Paste the bot token below.",
                    },
                ],
                schema: {
                    type: "object",
                    required: ["bot_token"],
                    properties: {
                        bot_token: {
                            type: "string",
                            title: "Bot Token",
                            description:
                                "Your Discord bot token from the Developer Portal.",
                            format: "password",
                        },
                        channels: {
                            type: "array",
                            title: "Channels",
                            description: "Channel or thread IDs.",
                            items: {
                                type: "object",
                                required: ["channel_id"],
                                properties: {
                                    channel_id: {
                                        type: "string",
                                        title: "Channel ID",
                                    },
                                },
                            },
                        },
                        users: {
                            type: "array",
                            title: "Direct Messages",
                            description: "User IDs to send direct messages to.",
                            items: {
                                type: "object",
                                required: ["user_id"],
                                properties: {
                                    user_id: {
                                        type: "string",
                                        title: "User ID",
                                    },
                                },
                            },
                        },
                    },
                },
            },
            watchthatsite_bot: {
                label: "WatchThatSite Bot",
                description:
                    "Click the button below to install our bot to your server. Skip if already installed.",
                installAction: "discord_bot",
                steps: [
                    {
                        text: "Press Install WatchThatSite Bot and choose your server. You need the Manage Server permission there.",
                    },
                    {
                        text: 'In Discord, turn on Developer Mode: User Settings → Advanced → Developer Mode. It adds the "Copy … ID" items used below.',
                    },
                    {
                        text: "Right-click each channel or thread to notify → Copy Channel ID, and add it under Channels. Check that the bot can see and post in it (Edit Channel → Permissions).",
                    },
                    {
                        text: "For direct messages, right-click a person → Copy User ID and add it under Direct Messages. They must share a server with the bot.",
                    },
                ],
                schema: {
                    type: "object",
                    properties: {
                        channels: {
                            type: "array",
                            title: "Channels",
                            description:
                                "Channel or thread IDs. The bot must have access.",
                            items: {
                                type: "object",
                                required: ["channel_id"],
                                properties: {
                                    channel_id: {
                                        type: "string",
                                        title: "Channel ID",
                                    },
                                },
                            },
                        },
                        users: {
                            type: "array",
                            title: "Direct Messages",
                            description: "User IDs to send direct messages to.",
                            items: {
                                type: "object",
                                required: ["user_id"],
                                properties: {
                                    user_id: {
                                        type: "string",
                                        title: "User ID",
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        id: "telegram",
        name: "Telegram",
        description: "Send notifications to Telegram chats via bots.",
        icon: "/images/channels/telegram.svg",
        config_schema: { type: "object", properties: {} },
        config_variants: {
            bot_token: {
                label: "Bot Token",
                description: "Use your own Telegram bot token from @BotFather.",
                steps: [
                    {
                        text: 'Message @BotFather, send /newbot, and choose a name and a username ending in "bot". BotFather replies with the token.',
                        link: {
                            href: "https://t.me/BotFather",
                            label: "Open @BotFather",
                        },
                    },
                    {
                        text: "Open a chat with your bot and press Start, or add it to a group. A bot cannot message a chat that has not added it.",
                    },
                    {
                        text: "Find the chat ID. For a private chat, message @userinfobot and it replies with your ID. For a group, add @RawDataBot to it: it posts the chat's details, including the ID (a negative number, often starting with -100). Remove it afterwards.",
                        link: {
                            href: "https://t.me/userinfobot",
                            label: "Open @userinfobot",
                        },
                    },
                    {
                        text: "Paste the token and the chat IDs below.",
                    },
                ],
                schema: {
                    type: "object",
                    required: ["bot_token", "chats"],
                    properties: {
                        bot_token: {
                            type: "string",
                            title: "Bot Token",
                            description:
                                "Token from @BotFather. Format: 123456789:ABCdef...",
                            format: "password",
                            pattern: "^[0-9]{8,10}:[A-Za-z0-9_-]{35,}$",
                        },
                        chats: {
                            type: "array",
                            title: "Chats",
                            description:
                                "Chat IDs to send notifications to. Use @userinfobot to find your chat ID.",
                            minItems: 1,
                            items: {
                                type: "object",
                                required: ["chat_id"],
                                properties: {
                                    chat_id: {
                                        type: "string",
                                        title: "Chat ID",
                                    },
                                },
                            },
                        },
                    },
                },
            },
            watchthatsite_bot: {
                label: "WatchThatSite Bot",
                description:
                    "Click the button below to open our bot on Telegram, then add it to your group or start a DM.",
                installAction: "telegram_bot",
                steps: [
                    {
                        text: "Press Install @WatchThatSiteBot. For yourself, press Start in the chat that opens. For a group, add @WatchThatSiteBot to the group.",
                    },
                    {
                        text: "Find the chat ID. For a private chat, message @userinfobot and it replies with your ID. For a group, add @RawDataBot to it: it posts the chat's details, including the ID (a negative number, often starting with -100). Remove it afterwards.",
                        link: {
                            href: "https://t.me/userinfobot",
                            label: "Open @userinfobot",
                        },
                    },
                    {
                        text: "Add each chat ID under Chats. The bot only reaches chats it has been added to.",
                    },
                ],
                schema: {
                    type: "object",
                    required: ["chats"],
                    properties: {
                        chats: {
                            type: "array",
                            title: "Chats",
                            description:
                                "Chat IDs to send notifications to. The bot must have access to these chats.",
                            minItems: 1,
                            items: {
                                type: "object",
                                required: ["chat_id"],
                                properties: {
                                    chat_id: {
                                        type: "string",
                                        title: "Chat ID",
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        id: "webhook",
        name: "Webhook",
        description:
            "POST the full Change Record as signed JSON to your own endpoint.",
        icon: WEBHOOK_ICON,
        config_schema: {
            type: "object",
            required: ["endpoints"],
            properties: {
                endpoints: {
                    type: "array",
                    title: "Endpoints",
                    description:
                        "Each change is POSTed to every endpoint, signed with its secret (max 5).",
                    minItems: 1,
                    maxItems: 5,
                    items: {
                        type: "object",
                        required: ["url", "secret"],
                        properties: {
                            url: {
                                type: "string",
                                title: "Endpoint URL",
                                pattern: withInsecureHosts(
                                    "^https://[^\\s/?#@]+(?:[/?#]\\S*)?$",
                                ),
                            },
                            secret: {
                                type: "string",
                                title: "Signing Secret",
                                description:
                                    "At least 16 characters, e.g. from `openssl rand -hex 32`.",
                                format: "password",
                                pattern: "^\\S{16,}$",
                            },
                        },
                    },
                },
            },
        },
    },
];

export type NotificationConfig = {
    id: string;
    user_id: string;
    channel_id: string;
    name: string;
    credentials: Record<string, unknown>;
    enabled: boolean;
    created_at: string;
    updated_at: string;
};

const configSelect =
    "id,user_id,channel_id,name,credentials,enabled,created_at,updated_at";

export async function listNotificationConfigs({
    userId,
}: {
    userId: string;
}): Promise<NotificationConfig[]> {
    const client = await getPostgrestClient();
    const { data, error } = await client
        .from("notification_config")
        .select(configSelect)
        .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []) as NotificationConfig[];
}

export async function saveNotificationConfig(input: {
    userId: string;
    channelId: string;
    credentials: Record<string, unknown>;
}): Promise<NotificationConfig> {
    const client = await getPostgrestClient();

    const { data: existing } = await client
        .from("notification_config")
        .select("id")
        .eq("channel_id", input.channelId)
        .eq("user_id", input.userId)
        .maybeSingle();

    if (existing?.id) {
        const { data, error } = await client
            .from("notification_config")
            .update({ credentials: input.credentials, enabled: true })
            .eq("id", existing.id)
            .select(configSelect)
            .single();
        if (error) throw new Error(error.message);
        return data as NotificationConfig;
    }

    const { data, error } = await client
        .from("notification_config")
        .insert({
            user_id: input.userId,
            channel_id: input.channelId,
            name: input.channelId,
            credentials: input.credentials,
            // Connecting a provider means wanting to hear from it.
            enabled: true,
        })
        .select(configSelect)
        .single();
    if (error) throw new Error(error.message);
    return data as NotificationConfig;
}

export async function updateNotificationConfigActive(
    id: string,
    isActive: boolean,
): Promise<NotificationConfig> {
    const client = await getPostgrestClient();
    const { data, error } = await client
        .from("notification_config")
        .update({ enabled: isActive })
        .eq("id", id)
        .select(configSelect)
        .single();
    if (error) throw new Error(error.message);
    return data as NotificationConfig;
}

export async function deleteNotificationConfig(id: string): Promise<void> {
    const client = await getPostgrestClient();
    const { error } = await client
        .from("notification_config")
        .delete()
        .eq("id", id);
    if (error) throw new Error(error.message);
}
