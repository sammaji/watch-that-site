"use client";

import {
    useCreateConnection,
    useUpdateConnection,
    type ConnectionCredentials,
} from "@/hooks/use-connections";
import {
    defaultName,
    ENDPOINTS,
    formatDeployments,
    parseDeployments,
    providerLabel,
    PROVIDERS,
    providerSpec,
    type ProviderField,
} from "@/lib/connections/providers";
import type { ProviderConnection } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@watchthatsite/ui/components/dialog";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { Textarea } from "@watchthatsite/ui/components/textarea";
import React from "react";
import { toast } from "sonner";
import { ProviderLogo } from "./provider-logo";

/**
 * Keeps password managers out of these fields. Without it a browser fills
 * the name with the sign-in email, because a password-type field (the key)
 * sits next to it.
 */
const NO_AUTOFILL = {
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "data-bwignore": true,
} as const;

/** The picker's value: a provider of the gateway, or a custom endpoint. */
type Choice = { kind: string; endpoint: boolean };

function choiceValue(choice: Choice): string {
    return `${choice.endpoint ? "endpoint" : "provider"}:${choice.kind}`;
}

function parseChoice(value: string): Choice {
    const [type, kind = ""] = value.split(":");
    return { kind, endpoint: type === "endpoint" };
}

type FormState = {
    choice: Choice;
    name: string;
    /** False until the person types a name: until then it follows the provider. */
    nameTouched: boolean;
    apiKey: string;
    baseUrl: string;
    fields: Record<string, string>;
    deployments: string;
    /** True once any credential or provider setting was changed. */
    credentialsTouched: boolean;
};

function initialState(connection: ProviderConnection | null): FormState {
    const settings = connection?.settings ?? {};
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
        if (typeof value === "string") fields[key] = value;
    }
    const deployments =
        settings.deployments && typeof settings.deployments === "object" ?
            formatDeployments(settings.deployments as Record<string, string>)
        :   "";
    return {
        choice: {
            kind: connection?.kind ?? "openai",
            endpoint: Boolean(connection?.base_url),
        },
        name: connection?.name ?? "",
        nameTouched: connection !== null,
        apiKey: "",
        baseUrl: connection?.base_url ?? "",
        fields,
        deployments,
        credentialsTouched: false,
    };
}

/**
 * Adds a connection, or edits one when `connection` is given. Secrets start
 * empty on edit: they cannot be read back, only replaced, and changing any
 * of the provider's settings asks for them again.
 */
export function ConnectionFormDialog({
    open,
    connection,
    onClose,
}: {
    open: boolean;
    connection: ProviderConnection | null;
    onClose: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={next => !next && onClose()}>
            <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0">
                {/* Mounted per opening, so the form always starts from the saved values. */}
                {open && (
                    <ConnectionForm connection={connection} onClose={onClose} />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ConnectionForm({
    connection,
    onClose,
}: {
    connection: ProviderConnection | null;
    onClose: () => void;
}) {
    const isEdit = connection !== null;
    const [form, setForm] = React.useState(() => initialState(connection));
    const [formError, setFormError] = React.useState<string | null>(null);

    const create = useCreateConnection();
    const update = useUpdateConnection();
    const isSaving = create.isPending || update.isPending;

    const { choice } = form;
    const spec = choice.endpoint ? undefined : providerSpec(choice.kind);
    const endpoint =
        choice.endpoint ? ENDPOINTS.find(e => e.id === choice.kind) : undefined;
    const keyMeta =
        endpoint ?
            { label: "API key", required: true, placeholder: "" }
        :   (spec?.key ?? null);

    const name =
        form.nameTouched ?
            form.name
        :   defaultName(
                choice.kind,
                choice.endpoint ? form.baseUrl : "",
                form.fields,
            );

    function change(patch: Partial<FormState>, credentials = true) {
        setForm(current => ({
            ...current,
            ...patch,
            credentialsTouched: current.credentialsTouched || credentials,
        }));
        setFormError(null);
    }

    function setField(field: string, value: string) {
        setForm(current => ({
            ...current,
            fields: { ...current.fields, [field]: value },
            credentialsTouched: true,
        }));
        setFormError(null);
    }

    // Everything the server needs to build the gateway key, minus the name.
    function credentials(): ConnectionCredentials {
        const fields: Record<string, string> = {};
        for (const field of spec?.fields ?? []) {
            const value = form.fields[field.name]?.trim();
            if (value) fields[field.name] = value;
        }
        return {
            kind: choice.kind,
            baseUrl: choice.endpoint ? form.baseUrl.trim() || null : null,
            apiKey: form.apiKey.trim() || undefined,
            ...(spec?.fields.length ? { fields } : {}),
            ...(spec?.deployments ?
                { deployments: parseDeployments(form.deployments) }
            :   {}),
        };
    }

    // On edit, nothing typed means the saved credentials stay.
    const keepsSaved = isEdit && !form.credentialsTouched;
    const missing = keepsSaved ? null : missingField();
    const canSave = name.trim().length > 0 && missing === null;

    function missingField(): string | null {
        if (choice.endpoint && !form.baseUrl.trim()) return "the base URL";
        if (keyMeta?.required && !form.apiKey.trim()) return keyMeta.label;
        for (const field of spec?.fields ?? []) {
            if (field.required && !form.fields[field.name]?.trim()) {
                return field.label;
            }
        }
        if (
            choice.kind === "bedrock" &&
            !choice.endpoint &&
            !form.apiKey.trim() &&
            !(form.fields.access_key?.trim() && form.fields.secret_key?.trim())
        ) {
            return "a Bedrock API key or an access key";
        }
        return null;
    }

    function save(event: React.FormEvent) {
        event.preventDefault();
        if (!canSave) return;
        setFormError(null);

        if (isEdit) {
            const changed: Partial<ConnectionCredentials> = credentials();
            delete changed.kind;
            update.mutate(
                {
                    id: connection.id,
                    name: name.trim(),
                    ...(form.credentialsTouched ? changed : {}),
                },
                {
                    onSuccess: saved => {
                        announce(saved, "Connection saved");
                        onClose();
                    },
                    onError: err => setFormError(err.message),
                },
            );
            return;
        }
        create.mutate(
            { ...credentials(), name: name.trim() },
            {
                onSuccess: saved => {
                    announce(saved, "Connection added");
                    onClose();
                },
                onError: err => setFormError(err.message),
            },
        );
    }

    return (
        <form onSubmit={save} autoComplete="off">
            <DialogHeader className="border-b p-4">
                <DialogTitle className="font-normal">
                    {isEdit ? "Edit connection" : "Add a model connection"}
                </DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4 p-4">
                <div className="space-y-1.5">
                    <Label htmlFor="connection-provider">Provider</Label>
                    <Select
                        value={choiceValue(choice)}
                        // The provider decides where the key goes, so it is fixed once saved.
                        disabled={isEdit}
                        onValueChange={value =>
                            change({
                                choice: parseChoice(value),
                                fields: {},
                                deployments: "",
                                baseUrl: "",
                            })
                        }>
                        <SelectTrigger
                            id="connection-provider"
                            className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-80">
                            <SelectGroup>
                                <SelectLabel>Providers</SelectLabel>
                                {PROVIDERS.map(p => (
                                    <SelectItem
                                        key={p.id}
                                        value={choiceValue({
                                            kind: p.id,
                                            endpoint: false,
                                        })}>
                                        <ProviderLogo kind={p.id} />
                                        {p.label}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                            <SelectSeparator />
                            <SelectGroup>
                                <SelectLabel>Custom endpoint</SelectLabel>
                                {ENDPOINTS.map(e => (
                                    <SelectItem
                                        key={e.id}
                                        value={choiceValue({
                                            kind: e.id,
                                            endpoint: true,
                                        })}>
                                        <ProviderLogo
                                            kind={e.id}
                                            baseUrl="custom"
                                        />
                                        {e.label}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                    {(endpoint?.description ?? spec?.note) && (
                        <p className="text-muted-foreground text-xs">
                            {endpoint?.description ?? spec?.note}
                        </p>
                    )}
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="connection-name">Name</Label>
                    <Input
                        id="connection-name"
                        name="connection-name"
                        autoComplete="off"
                        {...NO_AUTOFILL}
                        value={name}
                        maxLength={100}
                        onChange={e =>
                            change(
                                { name: e.target.value, nameTouched: true },
                                false,
                            )
                        }
                    />
                </div>

                {endpoint && (
                    <TextField
                        id="connection-base-url"
                        label="Base URL"
                        type="url"
                        value={form.baseUrl}
                        placeholder={endpoint.placeholder}
                        help={
                            endpoint.id === "openai" ?
                                "The address before /chat/completions. It usually ends in /v1."
                            :   "The address before /v1/messages."
                        }
                        onChange={value => change({ baseUrl: value })}
                    />
                )}

                {keyMeta && (
                    <SecretField
                        id="connection-key"
                        label={keyMeta.label}
                        optional={!keyMeta.required}
                        value={form.apiKey}
                        placeholder={
                            isEdit ?
                                `Leave empty to keep the saved key${connection.api_key_hint ? ` (ends in ${connection.api_key_hint})` : ""}`
                            :   (keyMeta.placeholder ?? "")
                        }
                        onChange={value => change({ apiKey: value })}
                    />
                )}

                {spec?.fields.map(field => (
                    <ProviderFieldInput
                        key={field.name}
                        field={field}
                        value={form.fields[field.name] ?? ""}
                        isEdit={isEdit}
                        onChange={value => setField(field.name, value)}
                    />
                ))}

                {spec?.deployments && (
                    <div className="space-y-1.5">
                        <Label htmlFor="connection-deployments">
                            {spec.deployments.label}
                        </Label>
                        <Textarea
                            id="connection-deployments"
                            value={form.deployments}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="gpt-4o = my-gpt4o"
                            onChange={e =>
                                change({ deployments: e.target.value })
                            }
                        />
                        <p className="text-muted-foreground text-xs">
                            {spec.deployments.help}
                        </p>
                    </div>
                )}

                {isEdit && form.credentialsTouched && (
                    <p className="text-muted-foreground text-xs">
                        Saved secrets cannot be read back: enter them again to
                        change {providerLabel(choice.kind, connection.base_url)}{" "}
                        settings.
                    </p>
                )}

                {missing && (
                    <p className="text-muted-foreground text-xs">
                        Enter {missing} to save.
                    </p>
                )}

                {formError && (
                    <p role="alert" className="text-destructive text-sm">
                        {formError}
                    </p>
                )}
            </div>

            <DialogFooter className="border-t p-3">
                <DialogClose asChild>
                    <Button type="button" variant="outline">
                        Cancel
                    </Button>
                </DialogClose>
                <Button type="submit" disabled={!canSave} isLoading={isSaving}>
                    {isEdit ? "Save" : "Add connection"}
                </Button>
            </DialogFooter>
        </form>
    );
}

function TextField({
    id,
    label,
    type = "text",
    value,
    placeholder,
    help,
    optional,
    onChange,
}: {
    id: string;
    label: string;
    type?: "text" | "url";
    value: string;
    placeholder?: string | undefined;
    help?: string | undefined;
    optional?: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <div className="space-y-1.5">
            <Label htmlFor={id}>
                {label}
                {optional && (
                    <span className="text-muted-foreground font-normal">
                        {" "}
                        (optional)
                    </span>
                )}
            </Label>
            <Input
                id={id}
                name={id}
                type={type}
                inputMode={type === "url" ? "url" : undefined}
                autoComplete="off"
                {...NO_AUTOFILL}
                value={value}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value)}
            />
            {help && <p className="text-muted-foreground text-xs">{help}</p>}
        </div>
    );
}

function SecretField({
    id,
    label,
    value,
    placeholder,
    optional,
    onChange,
}: {
    id: string;
    label: string;
    value: string;
    placeholder?: string;
    optional?: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <div className="space-y-1.5">
            <Label htmlFor={id}>
                {label}
                {optional && (
                    <span className="text-muted-foreground font-normal">
                        {" "}
                        (optional)
                    </span>
                )}
            </Label>
            <Input
                id={id}
                name={id}
                type="password"
                autoComplete="new-password"
                {...NO_AUTOFILL}
                value={value}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value)}
            />
        </div>
    );
}

function ProviderFieldInput({
    field,
    value,
    isEdit,
    onChange,
}: {
    field: ProviderField;
    value: string;
    isEdit: boolean;
    onChange: (value: string) => void;
}) {
    const id = `connection-field-${field.name}`;
    if (field.kind === "secret") {
        return (
            <SecretField
                id={id}
                label={field.label}
                optional={!field.required}
                value={value}
                placeholder={isEdit ? "Enter again to change" : ""}
                onChange={onChange}
            />
        );
    }
    if (field.kind === "json") {
        return (
            <div className="space-y-1.5">
                <Label htmlFor={id}>{field.label}</Label>
                <Textarea
                    id={id}
                    value={value}
                    rows={4}
                    autoComplete="off"
                    {...NO_AUTOFILL}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={
                        isEdit ?
                            "Paste the key again to change it"
                        :   '{"type": "service_account", ...}'
                    }
                    onChange={e => onChange(e.target.value)}
                />
                {field.help && (
                    <p className="text-muted-foreground text-xs">
                        {field.help}
                    </p>
                )}
            </div>
        );
    }
    return (
        <TextField
            id={id}
            label={field.label}
            type={field.kind === "url" ? "url" : "text"}
            optional={!field.required}
            value={value}
            placeholder={field.placeholder}
            help={field.help}
            onChange={onChange}
        />
    );
}

/**
 * Says how the save went. The model gateway checks the key itself when it
 * is added or changed; a key it could not use is saved anyway, so say so.
 */
function announce(saved: ProviderConnection, message: string) {
    if (saved.status?.state === "failing") {
        toast.warning(`${message}, but the key is not working yet`, {
            description: saved.status.error ?? undefined,
        });
        return;
    }
    toast.success(message);
}
