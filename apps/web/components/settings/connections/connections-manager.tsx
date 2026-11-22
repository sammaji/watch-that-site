"use client";

import { useConnections } from "@/hooks/use-connections";
import { Button } from "@watchthatsite/ui/components/button";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import { KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import React from "react";
import { ConnectionFormDialog } from "./connection-form-dialog";
import { ConnectionModelsDialog } from "./connection-models-dialog";
import { ConnectionsTable } from "./connections-table";
import { DeleteConnectionDialog } from "./delete-connection-dialog";

/** Which dialog is open, and for which connection. */
type Open =
    | { dialog: "add" }
    | { dialog: "edit" | "models" | "delete"; id: string }
    | null;

export function ConnectionsManager() {
    const { data, isLoading, error } = useConnections();
    const [open, setOpen] = React.useState<Open>(null);
    const close = () => setOpen(null);

    // Only the owner's own keys: the platform credit has its own page
    // (Usage), and cannot be edited, re-keyed or deleted.
    const own = React.useMemo(
        () => (data ?? []).filter(c => !c.managed),
        [data],
    );

    // Looked up by id, so an open dialog follows the list as it refreshes.
    const target = (dialog: "edit" | "models" | "delete") =>
        open?.dialog === dialog ?
            (own.find(c => c.id === open.id) ?? null)
        :   null;
    const editing = target("edit");

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-semibold tracking-normal">BYOK</h1>
                <Button onClick={() => setOpen({ dialog: "add" })}>
                    <Plus /> Add key
                </Button>
            </div>

            {isLoading ?
                <div className="space-y-3 rounded-lg border p-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-64 max-w-full" />
                </div>
            : error ?
                <p role="alert" className="text-destructive text-sm">
                    Could not load your keys: {error.message}
                </p>
            : own.length === 0 ?
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
                    <KeyRound className="text-muted-foreground size-6" />
                    <p className="text-sm font-medium">
                        No keys of your own yet
                    </p>
                    <p className="text-muted-foreground max-w-md text-sm">
                        Your Monitors use your WatchThatSite credit until you
                        add one. See what is left of it under{" "}
                        <Link
                            href="/usage"
                            className="underline underline-offset-4">
                            Usage
                        </Link>
                        .
                    </p>
                </div>
            :   <ConnectionsTable
                    connections={own}
                    onEdit={c => setOpen({ dialog: "edit", id: c.id })}
                    onEditModels={c => setOpen({ dialog: "models", id: c.id })}
                    onDelete={c => setOpen({ dialog: "delete", id: c.id })}
                />
            }

            <ConnectionFormDialog
                open={open?.dialog === "add" || editing !== null}
                connection={editing}
                onClose={close}
            />
            <ConnectionModelsDialog
                connection={target("models")}
                onClose={close}
            />
            <DeleteConnectionDialog
                connection={target("delete")}
                onClose={close}
            />
        </div>
    );
}
