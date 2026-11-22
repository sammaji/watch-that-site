"use client";

import { authClient } from "@watchthatsite/auth/client";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@watchthatsite/ui/components/dialog";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import { useRouter } from "next/navigation";
import React from "react";

export function DeleteAccountConfirmationModal() {
    const [confirmation, setConfirmation] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [isDeleting, startTransition] = React.useTransition();
    const router = useRouter();

    // Deleting the account also ends its sessions; the database removes
    // everything the account owns with it.
    const handleDeleteAccount = () => {
        setError(null);
        startTransition(async () => {
            const res = await authClient.deleteUser();
            if (res.error) {
                setError(res.error.message ?? "Could not delete your account.");
                return;
            }
            try {
                localStorage.removeItem("bearer_token");
            } catch {
                // no storage: nothing to clear
            }
            router.replace("/login");
        });
    };

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="destructive" size="sm">
                    Delete account
                </Button>
            </DialogTrigger>

            <DialogContent>
                <DialogHeader className="border-b pb-4">
                    <DialogTitle className="font-normal">
                        Delete account
                    </DialogTitle>
                    <DialogDescription>
                        This deletes your account and everything in it:
                        Monitors, Runs, Changes, Connections, Channels and API
                        keys. It cannot be undone.
                    </DialogDescription>
                </DialogHeader>

                <div className="my-4">
                    <div className="space-y-4">
                        <Label>
                            To verify, type <b>“delete my account”</b> below:
                        </Label>
                        <Input
                            value={confirmation}
                            onChange={e => setConfirmation(e.target.value)}
                        />
                        {error && (
                            <p className="text-destructive text-sm">{error}</p>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <DialogClose asChild>
                        <Button size="sm" variant="secondary">
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button
                        size="sm"
                        disabled={confirmation !== "delete my account"}
                        variant="destructive"
                        isLoading={isDeleting}
                        onClick={() => handleDeleteAccount()}>
                        Delete account
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
