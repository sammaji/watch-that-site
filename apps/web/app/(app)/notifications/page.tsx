"use client";

import {
    deleteNotificationConfig,
    listNotificationConfigs,
    NOTIFICATION_CHANNELS,
    saveNotificationConfig,
    updateNotificationConfigActive,
    type ConfigVariant,
    type JsonSchema,
    type JsonSchemaArrayProp,
    type JsonSchemaProp,
    type NotificationChannel,
    type NotificationConfig,
    type SetupStep,
} from "@/lib/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@watchthatsite/auth/client";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Card,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@watchthatsite/ui/components/card";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@watchthatsite/ui/components/collapsible";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@watchthatsite/ui/components/dialog";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import { ScrollArea } from "@watchthatsite/ui/components/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { Switch } from "@watchthatsite/ui/components/switch";
import { cn } from "@watchthatsite/ui/lib/utils";
import { ChevronDown, ExternalLink, Plus, X } from "lucide-react";
import React from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";

// ---------- helpers ----------

function keyToLabel(key: string): string {
    return key
        .split("_")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

function emptyItemFromSchema(
    prop: JsonSchemaArrayProp,
): Record<string, string> {
    return Object.fromEntries(
        Object.keys(prop.items?.properties ?? {}).map(k => [k, ""]),
    );
}

function initFormValues(
    schema: JsonSchema,
    existing: Record<string, unknown>,
): Record<string, unknown> {
    const init: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (prop.type === "array") {
            const arr = existing[key] as
                Array<Record<string, string>> | undefined;
            const arrayProp = prop as JsonSchemaArrayProp;
            init[key] =
                arr && arr.length > 0 ? arr
                : (arrayProp.minItems ?? 0) > 0 ?
                    [emptyItemFromSchema(arrayProp)]
                :   [];
        } else {
            init[key] = (existing[key] as string) ?? "";
        }
    }
    return init;
}

type FormValues = Record<string, unknown>;

// ---------- schema-driven form ----------

function SchemaStringField({
    propKey,
    prop,
    required,
    control,
}: {
    propKey: string;
    prop: JsonSchemaProp & { type: "string" };
    required: boolean;
    control: ReturnType<typeof useForm<FormValues>>["control"];
}) {
    const label = prop.title ?? keyToLabel(propKey);

    return (
        <Controller
            name={propKey}
            control={control}
            rules={{
                ...(required && { required: `${label} is required` }),
                ...(prop.pattern && {
                    pattern: {
                        value: new RegExp(prop.pattern),
                        message: `Invalid format for ${label.toLowerCase()}`,
                    },
                }),
            }}
            render={({ field, fieldState }) => (
                <div className="space-y-1.5">
                    <Label htmlFor={propKey}>
                        {label}
                        {required && (
                            <span className="text-destructive ml-0.5">*</span>
                        )}
                    </Label>
                    {prop.description && (
                        <p className="text-muted-foreground text-xs">
                            {prop.description}
                        </p>
                    )}
                    <Input
                        id={propKey}
                        type={prop.format === "password" ? "password" : "text"}
                        value={(field.value as string) ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        placeholder={label}
                        className={cn(fieldState.error && "border-destructive")}
                    />
                    {fieldState.error && (
                        <p className="text-destructive text-xs">
                            {fieldState.error.message}
                        </p>
                    )}
                </div>
            )}
        />
    );
}

function SchemaArrayField({
    propKey,
    prop,
    required,
    control,
}: {
    propKey: string;
    prop: JsonSchemaArrayProp;
    required: boolean;
    control: ReturnType<typeof useForm<FormValues>>["control"];
}) {
    const label = prop.title ?? keyToLabel(propKey);
    const itemProps = prop.items?.properties ?? {};
    const itemRequired = prop.items?.required ?? [];
    const { fields, append, remove } = useFieldArray({
        // The schema is data-driven, so the field paths are not known to the
        // form's static type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        control: control as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        name: propKey as any,
    });

    return (
        <div className="space-y-2">
            <Label>
                {label}
                {required && <span className="text-destructive ml-0.5">*</span>}
            </Label>
            {prop.description && (
                <p className="text-muted-foreground text-xs">
                    {prop.description}
                </p>
            )}
            <div className="space-y-2">
                {fields.map((field, index) => (
                    <div
                        key={field.id}
                        className="relative space-y-3 rounded-lg border p-3">
                        {fields.length > (prop.minItems ?? 0) && (
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground absolute top-2 right-2 cursor-pointer"
                                onClick={() => remove(index)}>
                                <X className="size-3.5" />
                            </button>
                        )}
                        {Object.entries(itemProps).map(
                            ([itemKey, itemProp]) => (
                                <Controller
                                    key={itemKey}
                                    name={
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        `${propKey}.${index}.${itemKey}` as any
                                    }
                                    control={control}
                                    rules={{
                                        ...(itemRequired.includes(itemKey) && {
                                            required: `${itemProp.title ?? keyToLabel(itemKey)} is required`,
                                        }),
                                        ...("pattern" in itemProp &&
                                            itemProp.pattern && {
                                                pattern: {
                                                    value: new RegExp(
                                                        itemProp.pattern,
                                                    ),
                                                    message: `Invalid ${(itemProp.title ?? keyToLabel(itemKey)).toLowerCase()}`,
                                                },
                                            }),
                                    }}
                                    render={({ field: f, fieldState }) => (
                                        <div className="space-y-1.5">
                                            <Label
                                                htmlFor={`${propKey}-${index}-${itemKey}`}>
                                                {itemProp.title ??
                                                    keyToLabel(itemKey)}
                                            </Label>
                                            {itemProp.description && (
                                                <p className="text-muted-foreground text-xs">
                                                    {itemProp.description}
                                                </p>
                                            )}
                                            <Input
                                                id={`${propKey}-${index}-${itemKey}`}
                                                type={
                                                    (
                                                        itemProp.format ===
                                                        "password"
                                                    ) ?
                                                        "password"
                                                    :   "text"
                                                }
                                                autoComplete={
                                                    (
                                                        itemProp.format ===
                                                        "password"
                                                    ) ?
                                                        "new-password"
                                                    :   undefined
                                                }
                                                value={
                                                    (f.value as string) ?? ""
                                                }
                                                onChange={f.onChange}
                                                onBlur={f.onBlur}
                                                placeholder={
                                                    itemProp.title ??
                                                    keyToLabel(itemKey)
                                                }
                                                className={cn(
                                                    fieldState.error &&
                                                        "border-destructive",
                                                )}
                                            />
                                            {fieldState.error && (
                                                <p className="text-destructive text-xs">
                                                    {fieldState.error.message}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                />
                            ),
                        )}
                    </div>
                ))}
            </div>
            {(prop.maxItems === undefined || fields.length < prop.maxItems) && (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append(emptyItemFromSchema(prop))}>
                    <Plus className="size-3.5" />
                    {fields.length === 0 ? "Add" : "Add more"}
                </Button>
            )}
        </div>
    );
}

function SchemaField({
    propKey,
    prop,
    required,
    control,
}: {
    propKey: string;
    prop: JsonSchemaProp;
    required: boolean;
    control: ReturnType<typeof useForm<FormValues>>["control"];
}) {
    if (prop.type === "string") {
        return (
            <SchemaStringField
                propKey={propKey}
                prop={prop as JsonSchemaProp & { type: "string" }}
                required={required}
                control={control}
            />
        );
    }
    if (prop.type === "array") {
        return (
            <SchemaArrayField
                propKey={propKey}
                prop={prop as JsonSchemaArrayProp}
                required={required}
                control={control}
            />
        );
    }
    return null;
}

// ---------- variant helpers ----------

function getActiveSchema(
    channel: NotificationChannel,
    variantType: string | undefined,
): JsonSchema {
    if (channel.config_variants && variantType) {
        return (
            channel.config_variants[variantType]?.schema ??
            channel.config_schema
        );
    }
    return channel.config_schema;
}

function getActiveVariant(
    channel: NotificationChannel,
    variantType: string | undefined,
): ConfigVariant | undefined {
    if (channel.config_variants && variantType) {
        return channel.config_variants[variantType];
    }
    return undefined;
}

function getInitialVariantType(
    channel: NotificationChannel,
    config: NotificationConfig | undefined,
): string | undefined {
    if (!channel.config_variants) return undefined;
    const stored = (config?.credentials as Record<string, unknown>)?.type as
        string | undefined;
    if (stored && stored in channel.config_variants) return stored;
    return Object.keys(channel.config_variants)[0];
}

// ---------- install bot button ----------

function InstallTelegramBotButton() {
    return (
        <Button
            type="button"
            onClick={() => {
                window.open(
                    "https://t.me/WatchThatSiteBot",
                    "_blank",
                    "noopener,noreferrer",
                );
            }}>
            Install @WatchThatSiteBot
        </Button>
    );
}

/** The numbered setup steps for a connection type, open until folded away. */
function SetupSteps({ steps }: { steps: SetupStep[] }) {
    return (
        <Collapsible defaultOpen className="rounded-md border">
            <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium">
                How to set this up
                <ChevronDown className="text-muted-foreground size-4 transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
                <ol className="text-muted-foreground list-decimal space-y-2 px-3 pb-3 pl-7 text-xs leading-5">
                    {steps.map((step, i) => (
                        <li key={i}>
                            {step.text}
                            {step.link ?
                                <>
                                    {" "}
                                    <a
                                        href={step.link.href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2">
                                        {step.link.label}
                                        <ExternalLink className="size-3" />
                                    </a>
                                </>
                            :   null}
                        </li>
                    ))}
                </ol>
            </CollapsibleContent>
        </Collapsible>
    );
}

// ---------- configure dialog ----------

function ConfigureDialog({
    channel,
    config,
    userId,
    open: openProp,
    onOpenChange: onOpenChangeProp,
}: {
    channel: NotificationChannel;
    config: NotificationConfig | undefined;
    userId: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const [internalOpen, setInternalOpen] = React.useState(false);
    const open = openProp ?? internalOpen;
    const setOpen = onOpenChangeProp ?? setInternalOpen;

    const hasVariants = !!channel.config_variants;
    const [variantType, setVariantType] = React.useState<string | undefined>(
        () => getInitialVariantType(channel, config),
    );

    const activeSchema = getActiveSchema(channel, variantType);
    const activeVariant = getActiveVariant(channel, variantType);

    const form = useForm<FormValues>({
        defaultValues: initFormValues(activeSchema, config?.credentials ?? {}),
    });

    // Each time the dialog opens, start from the saved variant. The variant
    // is adjusted during render; the form reset is an external store, so it
    // stays in an effect.
    const [wasOpen, setWasOpen] = React.useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setVariantType(getInitialVariantType(channel, config));
    }
    React.useEffect(() => {
        if (open) {
            const schema = getActiveSchema(
                channel,
                getInitialVariantType(channel, config),
            );
            form.reset(initFormValues(schema, config?.credentials ?? {}));
        }
    }, [open, channel, config, form]);

    function handleVariantChange(type: string) {
        setVariantType(type);
        const schema = getActiveSchema(channel, type);
        const storedType = (config?.credentials as Record<string, unknown>)
            ?.type;
        const creds = storedType === type ? (config?.credentials ?? {}) : {};
        form.reset(initFormValues(schema, creds));
    }

    const saveMutation = useMutation({
        mutationFn: saveNotificationConfig,
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: ["notification-configs"],
            });
            toast.success(`${channel.name} connected`);
            setOpen(false);
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: deleteNotificationConfig,
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: ["notification-configs"],
            });
            toast.success(`${channel.name} disconnected`);
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    function onSubmit(values: FormValues) {
        const credentials =
            hasVariants ? { ...values, type: variantType } : values;
        saveMutation.mutate({
            userId,
            channelId: channel.id,
            credentials,
        });
    }

    return (
        <div className="flex items-center gap-2">
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                        {config ? "Edit" : "Connect"}
                    </Button>
                </DialogTrigger>
                <DialogContent className="gap-0 p-0">
                    <DialogHeader className="border-b p-4">
                        <DialogTitle className="font-normal">
                            {config ?
                                `Edit ${channel.name}`
                            :   `Connect ${channel.name}`}
                        </DialogTitle>
                    </DialogHeader>

                    {channel.id === "slack" && (
                        <Collapsible defaultOpen={false} className="border-b">
                            <CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-left text-sm font-medium">
                                Instructions
                                <ChevronDown className="text-muted-foreground size-4 transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="space-y-2 px-4 pb-4">
                                <p className="text-muted-foreground text-sm">
                                    Go to api.slack.com/apps, click Create New
                                    App, choose From Scratch, and pick your
                                    workspace.
                                </p>
                                <p className="text-muted-foreground text-sm">
                                    In the left sidebar, click Incoming Webhooks
                                    and toggle the switch to On.
                                </p>
                                <p className="text-muted-foreground text-sm">
                                    Click Add New Webhook to Workspace at the
                                    bottom, select your target channel, and hit
                                    Allow.
                                </p>
                                <p className="text-muted-foreground text-sm">
                                    Copy the link generated in the Webhook URLs
                                    section.
                                </p>
                            </CollapsibleContent>
                        </Collapsible>
                    )}
                    {channel.id === "webhook" && (
                        <Collapsible defaultOpen={false} className="border-b">
                            <CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-left text-sm font-medium">
                                Instructions
                                <ChevronDown className="text-muted-foreground size-4 transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
                            </CollapsibleTrigger>
                            <CollapsibleContent className="space-y-2 px-4 pb-4">
                                <p className="text-muted-foreground text-sm">
                                    Each change is sent as a POST with the full
                                    Change Record as its JSON body. Digests and
                                    “element not found” alerts use the same
                                    endpoint.
                                </p>
                                <p className="text-muted-foreground text-sm">
                                    The{" "}
                                    <code className="text-foreground">
                                        X-WatchThatSite-Event
                                    </code>{" "}
                                    header names the event:{" "}
                                    <code className="text-foreground">
                                        change
                                    </code>
                                    ,{" "}
                                    <code className="text-foreground">
                                        digest
                                    </code>{" "}
                                    or{" "}
                                    <code className="text-foreground">
                                        element_not_found
                                    </code>
                                    .
                                </p>
                                <p className="text-muted-foreground text-sm">
                                    Verify{" "}
                                    <code className="text-foreground">
                                        X-WatchThatSite-Signature: t=…,v1=…
                                    </code>{" "}
                                    by computing HMAC-SHA256 of{" "}
                                    <code className="text-foreground">
                                        {"{t}.{raw body}"}
                                    </code>{" "}
                                    with your secret, comparing it to v1 in
                                    constant time, and rejecting old values of
                                    t.
                                </p>
                                <p className="text-muted-foreground text-sm">
                                    Respond with any 2xx status. 429 and 5xx
                                    responses are retried; other statuses are
                                    not.
                                </p>
                            </CollapsibleContent>
                        </Collapsible>
                    )}
                    <div className="flex flex-col gap-4 p-4">
                        <ScrollArea className="max-h-[60vh]">
                            <div className="space-y-4">
                                {hasVariants && channel.config_variants && (
                                    <div className="space-y-1.5">
                                        <Label>Connection Type</Label>
                                        <Select
                                            value={variantType}
                                            onValueChange={handleVariantChange}>
                                            <SelectTrigger size="sm">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {Object.entries(
                                                    channel.config_variants,
                                                ).map(([key, variant]) => (
                                                    <SelectItem
                                                        key={key}
                                                        value={key}>
                                                        {variant.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        {activeVariant?.description && (
                                            <p className="text-muted-foreground text-xs">
                                                {activeVariant.description}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {activeVariant?.steps?.length ?
                                    <SetupSteps
                                        key={variantType}
                                        steps={activeVariant.steps}
                                    />
                                :   null}
                                {activeVariant?.installAction ===
                                    "telegram_bot" && (
                                    <InstallTelegramBotButton />
                                )}

                                {Object.entries(
                                    activeSchema.properties ?? {},
                                ).map(([key, prop]) => (
                                    <SchemaField
                                        key={`${variantType}-${key}`}
                                        propKey={key}
                                        prop={prop}
                                        required={
                                            activeSchema.required?.includes(
                                                key,
                                            ) ?? false
                                        }
                                        control={form.control}
                                    />
                                ))}
                            </div>
                        </ScrollArea>
                    </div>
                    <DialogFooter className="border-t p-3">
                        <DialogClose asChild>
                            <Button type="button" variant="outline">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            type="button"
                            onClick={form.handleSubmit(onSubmit)}
                            isLoading={saveMutation.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {config && (
                <Button
                    variant="outline"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(config.id)}>
                    Disconnect
                </Button>
            )}
        </div>
    );
}

// ---------- channel card ----------

function ChannelCard({
    channel,
    config,
    userId,
}: {
    channel: NotificationChannel;
    config: NotificationConfig | undefined;
    userId: string;
}) {
    const queryClient = useQueryClient();
    const hasSchema =
        Object.keys(channel.config_schema.properties ?? {}).length > 0 ||
        !!channel.config_variants;

    const [dialogOpen, setDialogOpen] = React.useState(false);

    const toggleMutation = useMutation({
        mutationFn: async (enabled: boolean) => {
            if (config) {
                return updateNotificationConfigActive(config.id, enabled);
            }
            return saveNotificationConfig({
                userId,
                channelId: channel.id,
                credentials: {},
            });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: ["notification-configs"],
            });
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    function handleToggle(checked: boolean) {
        if (checked && !config && hasSchema) {
            setDialogOpen(true);
            return;
        }
        toggleMutation.mutate(checked);
    }

    return (
        <Card>
            <CardHeader className="h-full pb-3">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                        <div className="bg-muted flex size-8 items-center justify-center rounded-md border">
                            <img
                                alt={channel.name}
                                className="text-muted-foreground size-4"
                                src={channel.icon}
                            />
                        </div>
                        <CardTitle className="text-base">
                            {channel.name}
                        </CardTitle>
                    </div>
                    <Switch
                        checked={config?.enabled ?? false}
                        onCheckedChange={handleToggle}
                        disabled={toggleMutation.isPending}
                    />
                </div>
                <CardDescription className="text-sm leading-relaxed">
                    {channel.description}
                </CardDescription>
            </CardHeader>
            <CardFooter>
                <ConfigureDialog
                    channel={channel}
                    config={config}
                    userId={userId}
                    open={dialogOpen}
                    onOpenChange={setDialogOpen}
                />
            </CardFooter>
        </Card>
    );
}

// ---------- page ----------

export default function NotificationsPage() {
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;

    const configsQuery = useQuery({
        queryKey: ["notification-configs", userId],
        queryFn: () => listNotificationConfigs({ userId: userId! }),
        enabled: !!userId,
    });

    const configByChannel = React.useMemo(() => {
        const map = new Map<string, NotificationConfig>();
        for (const cfg of configsQuery.data ?? []) {
            map.set(cfg.channel_id, cfg);
        }
        return map;
    }, [configsQuery.data]);

    return (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 py-6 sm:p-6">
            <section className="flex flex-col gap-1">
                <h1 className="text-2xl font-semibold tracking-normal">
                    Notifications
                </h1>
            </section>

            {configsQuery.isLoading ?
                <div className="grid gap-4 sm:grid-cols-2">
                    {[...Array(4)].map((_, i) => (
                        <Card key={i} className="animate-pulse">
                            <CardHeader className="pb-3">
                                <div className="flex items-center gap-2.5">
                                    <div className="bg-muted size-8 rounded-md" />
                                    <div className="bg-muted h-4 w-24 rounded" />
                                </div>
                                <div className="bg-muted mt-2 h-3 w-full rounded" />
                                <div className="bg-muted h-3 w-3/4 rounded" />
                            </CardHeader>
                            <CardFooter>
                                <div className="bg-muted h-8 w-20 rounded" />
                            </CardFooter>
                        </Card>
                    ))}
                </div>
            :   <div className="grid gap-4 sm:grid-cols-2">
                    {NOTIFICATION_CHANNELS.map(channel => (
                        <ChannelCard
                            key={channel.id}
                            channel={channel}
                            config={
                                userId ?
                                    configByChannel.get(channel.id)
                                :   undefined
                            }
                            userId={userId ?? ""}
                        />
                    ))}
                </div>
            }
        </main>
    );
}
