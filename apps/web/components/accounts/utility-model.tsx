"use client";

import { ModelPicker } from "@/components/monitor/create/model-picker";
import { useConnections } from "@/hooks/use-connections";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@watchthatsite/ui/components/button";
import { toast } from "sonner";

type Settings = {
    utility_connection_id: string | null;
    utility_model: string | null;
    default_utility_model: string;
};

async function request(init?: RequestInit): Promise<Settings> {
    const response = await fetch("/api/settings", {
        ...init,
        headers: { "Content-Type": "application/json" },
    });
    const json = (await response.json().catch(() => null)) as
        (Settings & { error?: string }) | null;
    if (!response.ok || !json) {
        throw new Error(json?.error ?? "Your settings could not be loaded.");
    }
    return json;
}

/**
 * The model for small jobs that are not a Monitor's: suggesting Instructions for a
 * new Monitor's page. Unset, it is the credit's mini model.
 */
export function UtilityModel() {
    const queryClient = useQueryClient();
    const connections = useConnections();
    const settings = useQuery({
        queryKey: ["settings"],
        queryFn: () => request(),
    });
    const save = useMutation({
        mutationFn: (value: {
            connectionId: string | null;
            model: string | null;
        }) =>
            request({
                method: "PUT",
                body: JSON.stringify({
                    utility_connection_id: value.connectionId,
                    utility_model: value.model,
                }),
            }),
        onSuccess: data => {
            queryClient.setQueryData(["settings"], data);
            toast.success("Utility model saved");
        },
        onError: error => toast.error(error.message),
    });

    const data = settings.data;
    const credit = connections.data?.find(c => c.managed) ?? null;
    const isDefault = !data?.utility_connection_id;
    const connectionId = data?.utility_connection_id ?? credit?.id ?? null;
    const model =
        data?.utility_model ?? (credit ? data?.default_utility_model : null);

    return (
        <div className="space-y-3">
            {settings.isLoading ?
                <p className="text-muted-foreground text-sm">Loading…</p>
            : settings.error ?
                <p role="alert" className="text-destructive text-sm">
                    {settings.error.message}
                </p>
            :   <ModelPicker
                    connectionId={connectionId}
                    model={model ?? null}
                    onChange={value => {
                        if (value.connectionId && value.model) {
                            save.mutate(value);
                        }
                    }}
                />
            }
            <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs">
                    {isDefault ?
                        "Using the default: wts-mini on your WatchThatSite credit."
                    :   "A small, fast model is enough for these jobs."}
                </p>
                {isDefault ? null : (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={save.isPending}
                        onClick={() =>
                            save.mutate({ connectionId: null, model: null })
                        }>
                        Use the default
                    </Button>
                )}
            </div>
        </div>
    );
}
