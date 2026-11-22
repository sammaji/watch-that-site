"use client";

import {
    connectionKeys,
    useUpdateConnection,
    type ConnectionModels,
} from "@/hooks/use-connections";
import { useQuery } from "@tanstack/react-query";
import type { ProviderConnection } from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import { Button } from "@watchthatsite/ui/components/button";
import { Checkbox } from "@watchthatsite/ui/components/checkbox";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@watchthatsite/ui/components/dialog";
import { Input } from "@watchthatsite/ui/components/input";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import { CircleAlert, Plus, RefreshCw } from "lucide-react";
import React from "react";
import { toast } from "sonner";
import { displayModel, gatewayModel } from "./meta";

/**
 * Chooses which of a connection's models Monitors may use, and the default.
 * The list is what the provider reports now, plus anything already enabled
 * and any id typed by hand (some gateways do not list their models).
 */
export function ConnectionModelsDialog({
    connection,
    onClose,
}: {
    /** The connection to edit; `null` keeps the dialog closed. */
    connection: ProviderConnection | null;
    onClose: () => void;
}) {
    return (
        <Dialog
            open={connection !== null}
            onOpenChange={next => !next && onClose()}>
            <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0">
                {connection && (
                    <ModelsEditor
                        key={connection.id}
                        connection={connection}
                        onClose={onClose}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ModelsEditor({
    connection,
    onClose,
}: {
    connection: ProviderConnection;
    onClose: () => void;
}) {
    const update = useUpdateConnection();

    // What the model gateway last listed for the connection's key.
    const listing = useQuery<ConnectionModels, Error>({
        queryKey: connectionKeys.models(connection.id),
        queryFn: async () => {
            const response = await fetch(
                `/api/connections/${connection.id}/models`,
                { cache: "no-store" },
            );
            const body = (await response.json().catch(() => null)) as
                (ConnectionModels & { error?: string | null }) | null;
            if (!response.ok || !body) {
                throw new Error(
                    body?.error ?? "Could not ask the gateway for the models.",
                );
            }
            return body;
        },
        staleTime: 60_000,
        retry: false,
    });

    const [enabled, setEnabled] = React.useState(
        () => new Set(connection.models),
    );
    const [added, setAdded] = React.useState<string[]>([]);
    const [defaultModel, setDefaultModel] = React.useState(
        connection.default_model,
    );
    const [search, setSearch] = React.useState("");
    const [draft, setDraft] = React.useState("");

    const listed = listing.data?.error ? undefined : listing.data?.models;
    // Ids typed by hand come first, then the default as it was when the
    // dialog opened, then the rest in the order the server sent them.
    const all = React.useMemo(
        () => [
            ...new Set([
                ...added,
                ...(connection.default_model ? [connection.default_model] : []),
                ...connection.models,
                ...(listed ?? []),
            ]),
        ],
        [added, connection.default_model, connection.models, listed],
    );
    const needle = search.trim().toLowerCase();
    const shown =
        needle ?
            all.filter(id =>
                displayModel(connection, id).toLowerCase().includes(needle),
            )
        :   all;

    function toggle(id: string, on: boolean) {
        const next = new Set(enabled);
        if (on) next.add(id);
        else next.delete(id);
        setEnabled(next);
        // Keep a default while anything is enabled, and never a disabled one.
        if (on && !defaultModel) setDefaultModel(id);
        if (!on && defaultModel === id) {
            setDefaultModel(all.find(model => next.has(model)) ?? null);
        }
    }

    function setAll(ids: string[], on: boolean) {
        const next = new Set(enabled);
        for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
        }
        setEnabled(next);
        if (!defaultModel || !next.has(defaultModel)) {
            setDefaultModel(all.find(model => next.has(model)) ?? null);
        }
    }

    function addByHand(event: React.FormEvent) {
        event.preventDefault();
        const typed = draft.trim();
        if (!typed) return;
        const id = gatewayModel(connection, typed);
        if (!all.includes(id)) setAdded(current => [id, ...current]);
        toggle(id, true);
        setDraft("");
        setSearch("");
    }

    function save() {
        // Saved in the order shown, so the list reads the same next time.
        const models = all.filter(id => enabled.has(id));
        update.mutate(
            { id: connection.id, models, defaultModel },
            {
                onSuccess: () => {
                    toast.success("Models saved");
                    onClose();
                },
                onError: err => toast.error(err.message),
            },
        );
    }

    const discoveryError =
        listing.error?.message ?? listing.data?.error ?? null;

    return (
        <>
            <DialogHeader className="border-b p-4">
                <DialogTitle className="font-normal">
                    Models for {connection.name}
                </DialogTitle>
                <DialogDescription>
                    Enabled models can be chosen on a Monitor. The default is
                    used when a Monitor does not name one.
                </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                {discoveryError && (
                    <div className="text-destructive flex items-start gap-2 text-sm">
                        <CircleAlert className="mt-0.5 size-4 shrink-0" />
                        <p className="min-w-0 break-words">
                            Could not list this provider&apos;s models.{" "}
                            {discoveryError} You can still add model ids by
                            hand.
                        </p>
                    </div>
                )}

                <form onSubmit={addByHand} className="flex gap-2">
                    <Input
                        aria-label="Model id to add"
                        value={draft}
                        maxLength={200}
                        placeholder="Add a model id by hand"
                        className="font-mono text-xs"
                        onChange={e => setDraft(e.target.value)}
                    />
                    <Button
                        type="submit"
                        variant="outline"
                        disabled={!draft.trim()}>
                        <Plus /> Add
                    </Button>
                </form>

                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        aria-label="Filter models"
                        value={search}
                        placeholder="Filter"
                        className="h-8 min-w-0 flex-1 basis-full sm:basis-40"
                        onChange={e => setSearch(e.target.value)}
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={shown.length === 0}
                        onClick={() => setAll(shown, true)}>
                        Enable all
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={shown.length === 0}
                        onClick={() => setAll(shown, false)}>
                        Disable all
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Ask the gateway for the models again"
                        disabled={listing.isFetching}
                        onClick={() => void listing.refetch()}>
                        <RefreshCw
                            className={
                                listing.isFetching ? "animate-spin" : undefined
                            }
                        />
                    </Button>
                </div>

                <ul className="min-h-24 flex-1 overflow-y-auto rounded-md border">
                    {shown.map(id => {
                        const on = enabled.has(id);
                        const isDefault = defaultModel === id;
                        return (
                            <li
                                key={id}
                                className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                    <Checkbox
                                        checked={on}
                                        onCheckedChange={value =>
                                            toggle(id, value === true)
                                        }
                                    />
                                    <span className="truncate font-mono text-xs">
                                        {displayModel(connection, id)}
                                    </span>
                                </label>
                                {isDefault ?
                                    <Badge variant="secondary">Default</Badge>
                                :   on && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="xs"
                                            onClick={() => setDefaultModel(id)}>
                                            Make default
                                        </Button>
                                    )
                                }
                            </li>
                        );
                    })}
                    {listing.isLoading && (
                        <li className="space-y-2 p-3">
                            <Skeleton className="h-4 w-2/3" />
                            <Skeleton className="h-4 w-1/2" />
                            <Skeleton className="h-4 w-3/5" />
                        </li>
                    )}
                    {!listing.isLoading && shown.length === 0 && (
                        <li className="text-muted-foreground p-3 text-sm">
                            {all.length === 0 ?
                                "No models yet. Add a model id by hand."
                            :   "No model matches the filter."}
                        </li>
                    )}
                </ul>
            </div>

            <DialogFooter className="flex-row items-center justify-between border-t p-3 sm:justify-between">
                <p className="text-muted-foreground text-xs">
                    {enabled.size} of {all.length} enabled
                </p>
                <div className="flex gap-2">
                    <DialogClose asChild>
                        <Button type="button" variant="outline">
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button
                        type="button"
                        isLoading={update.isPending}
                        onClick={save}>
                        Save models
                    </Button>
                </div>
            </DialogFooter>
        </>
    );
}
