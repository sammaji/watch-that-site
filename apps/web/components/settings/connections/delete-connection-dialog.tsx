"use client";

import { useDeleteConnection } from "@/hooks/use-connections";
import type { ProviderConnection } from "@watchthatsite/types";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@watchthatsite/ui/components/alert-dialog";
import { Button } from "@watchthatsite/ui/components/button";

export function DeleteConnectionDialog({
    connection,
    onClose,
}: {
    /** The connection to delete; `null` keeps the dialog closed. */
    connection: ProviderConnection | null;
    onClose: () => void;
}) {
    const remove = useDeleteConnection();

    return (
        <AlertDialog
            open={connection !== null}
            onOpenChange={open => {
                if (!open && !remove.isPending) onClose();
            }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle className="font-normal">
                        Delete “{connection?.name}”?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        Its key is removed from WatchThatSite&apos;s model
                        gateway. Monitors that use this connection fall back to
                        your next enabled connection.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={remove.isPending}>
                        Cancel
                    </AlertDialogCancel>
                    <Button
                        variant="destructive"
                        isLoading={remove.isPending}
                        onClick={() => {
                            if (!connection) return;
                            remove.mutate(connection.id, {
                                onSuccess: onClose,
                            });
                        }}>
                        Delete connection
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
