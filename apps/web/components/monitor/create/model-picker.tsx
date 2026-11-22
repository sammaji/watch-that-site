"use client";

import { SearchableSelect } from "@/components/searchable-select";
import { ProviderLogo } from "@/components/settings/connections/provider-logo";
import { useConnections } from "@/hooks/use-connections";
import { providerLabel } from "@/lib/connections/providers";
import type { ProviderConnection } from "@watchthatsite/types";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import React from "react";

/**
 * Chooses the model the agent uses for a Monitor: a connection, then one of
 * its models. The form itself fills in the first connection's default (see
 * MonitorForm), because this picker is folded away until it is opened.
 */
export function ModelPicker({
    connectionId,
    model,
    onChange,
}: {
    connectionId: string | null;
    model: string | null;
    onChange: (value: {
        connectionId: string | null;
        model: string | null;
    }) => void;
}) {
    const { data, isLoading, error } = useConnections();
    const connections = React.useMemo(
        () => (data ?? []).filter(c => c.enabled || c.id === connectionId),
        [data, connectionId],
    );
    const current = connections.find(c => c.id === connectionId) ?? null;

    if (isLoading) {
        return <p className="text-muted-foreground text-sm">Loading models…</p>;
    }

    if (error) {
        return (
            <p role="alert" className="text-destructive text-sm">
                Your model connections could not be loaded: {error.message}
            </p>
        );
    }

    if (connections.length === 0) {
        return (
            <div
                data-testid="no-connection"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <p className="min-w-0">
                    You have no model connection yet. Without one the agent
                    cannot judge changes, record pre-scraping or plan the page;
                    every difference is reported as it is.{" "}
                    <Link
                        href="/settings/connections"
                        className="font-medium underline underline-offset-2">
                        Add a connection
                    </Link>
                    . You can save this Monitor now and choose a model later.
                </p>
            </div>
        );
    }

    // A model saved earlier stays selectable even if the connection no
    // longer lists it.
    const models =
        current ?
            [...new Set([...current.models, model ?? ""].filter(m => m !== ""))]
        :   [];

    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
                <Label htmlFor="monitor-connection">Connection</Label>
                <Select
                    value={current?.id ?? ""}
                    onValueChange={id => {
                        const next = connections.find(c => c.id === id);
                        onChange({
                            connectionId: id,
                            model:
                                next?.default_model ?? next?.models[0] ?? null,
                        });
                    }}>
                    <SelectTrigger id="monitor-connection" className="w-full">
                        <SelectValue placeholder="Choose a connection" />
                    </SelectTrigger>
                    <SelectContent>
                        {connections.map(c => (
                            <SelectItem key={c.id} value={c.id}>
                                <ProviderLogo
                                    kind={c.kind}
                                    baseUrl={c.base_url}
                                />
                                {c.name}
                                {c.managed ? null : (
                                    <span className="text-muted-foreground">
                                        · {providerLabel(c.kind, c.base_url)}
                                    </span>
                                )}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="min-w-0 space-y-2">
                <Label htmlFor="monitor-model">Model</Label>
                {models.length > 0 ?
                    <SearchableSelect
                        id="monitor-model"
                        value={model}
                        onChange={next =>
                            onChange({ connectionId, model: next })
                        }
                        placeholder="Choose a model"
                        searchPlaceholder="Search models…"
                        empty="No model matches."
                        options={models.map(m => ({
                            value: m,
                            label: modelLabel(current, m),
                        }))}
                    />
                :   <Input
                        id="monitor-model"
                        placeholder="Model id, as the provider names it"
                        value={model ?? ""}
                        disabled={!current}
                        onChange={e =>
                            onChange({
                                connectionId,
                                model: e.target.value || null,
                            })
                        }
                    />
                }
            </div>
            {current && !current.enabled ?
                <p className="text-xs text-amber-700 sm:col-span-2 dark:text-amber-300">
                    This connection is turned off, so the agent cannot use it.
                    Turn it on in{" "}
                    <Link
                        href="/settings/connections"
                        className="underline underline-offset-2">
                        Connections
                    </Link>{" "}
                    or choose another.
                </p>
            : current?.status?.state === "failing" ?
                <p className="text-xs text-amber-700 sm:col-span-2 dark:text-amber-300">
                    The model gateway reports that this connection&apos;s key is
                    failing
                    {current.status.error ? `: ${current.status.error}` : "."}
                </p>
            :   null}
        </div>
    );
}

/**
 * A model as a person names it: without the gateway's provider prefix
 * (`openai/gpt-5.4` → `gpt-5.4`, `wts/wts-pro` → `wts-pro`). The full string
 * is still what is saved.
 */
function modelLabel(
    connection: ProviderConnection | null,
    model: string,
): string {
    const prefix = connection ? `${connection.gateway_provider}/` : "";
    return prefix && model.startsWith(prefix) ?
            model.slice(prefix.length)
        :   model;
}
