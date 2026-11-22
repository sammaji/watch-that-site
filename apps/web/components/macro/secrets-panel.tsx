"use client";

import { useMacroMutations, useMonitorSecrets } from "@/hooks/use-macros";
import { SECRET_NAME, secretRef } from "@/lib/macro";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@watchthatsite/ui/components/alert-dialog";
import { Button } from "@watchthatsite/ui/components/button";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import { KeyRound, Plus } from "lucide-react";
import React from "react";
import { toast } from "sonner";

/**
 * The named secrets a Monitor's Macro may type. A value can be added,
 * replaced or deleted, never read back: only its name and a hint (its last
 * four characters) ever reach the browser.
 */
export function SecretsPanel({
    monitorId,
    usedNames,
}: {
    monitorId: string;
    /**
     * Secret names the Macro in use refers to. Leave it out while the steps
     * are being edited, when what is used is not settled.
     */
    usedNames?: string[];
}) {
    const { secrets, isLoading, error } = useMonitorSecrets(monitorId);
    const { putSecret, deleteSecret } = useMacroMutations(monitorId);
    const [adding, setAdding] = React.useState(false);
    const [name, setName] = React.useState("");
    const [value, setValue] = React.useState("");
    const [replacing, setReplacing] = React.useState<string | null>(null);
    const [replacement, setReplacement] = React.useState("");
    const [deleting, setDeleting] = React.useState<string | null>(null);
    const [formError, setFormError] = React.useState<string | null>(null);

    const saved = new Set(secrets.map(s => s.name));
    const missing = (usedNames ?? []).filter(n => !saved.has(n));

    async function add(event: React.FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (!SECRET_NAME.test(trimmed)) {
            setFormError(
                "Use lowercase letters, digits and underscores, starting with a letter, for example “password”.",
            );
            return;
        }
        if (saved.has(trimmed)) {
            setFormError(
                `A secret named “${trimmed}” exists already. Replace its value instead.`,
            );
            return;
        }
        if (value === "") {
            setFormError("Enter the value to store.");
            return;
        }
        setFormError(null);
        try {
            await putSecret.mutateAsync({ name: trimmed, value });
            setName("");
            setValue("");
            setAdding(false);
            toast.success(`Secret “${trimmed}” saved.`);
        } catch (err) {
            setFormError(
                err instanceof Error ?
                    err.message
                :   "The secret was not saved.",
            );
        }
    }

    async function replace(event: React.FormEvent, secretName: string) {
        event.preventDefault();
        if (replacement === "") return;
        try {
            await putSecret.mutateAsync({
                name: secretName,
                value: replacement,
            });
            setReplacing(null);
            setReplacement("");
            toast.success(`Secret “${secretName}” replaced.`);
        } catch (err) {
            toast.error(
                err instanceof Error ?
                    err.message
                :   "The secret was not saved.",
            );
        }
    }

    return (
        <section aria-labelledby="secrets-heading" className="space-y-3">
            <div className="space-y-1">
                <h3 id="secrets-heading" className="text-base font-medium">
                    Secrets
                </h3>
                <p className="text-muted-foreground text-xs">
                    Passwords and other values pre-scraping types. They are
                    stored encrypted, typed into the page by the browser, and
                    never shown again or sent to the model. A step refers to one
                    as{" "}
                    <code className="bg-muted rounded px-1 font-mono">
                        {secretRef("name")}
                    </code>
                    .
                </p>
            </div>

            {missing.length ?
                <p
                    role="alert"
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    Pre-scraping types{" "}
                    <span className="font-mono">{missing.join(", ")}</span>,
                    which {missing.length === 1 ? "is" : "are"} not saved here.
                    Add {missing.length === 1 ? "it" : "them"}, or that step
                    will fail.
                </p>
            :   null}

            {error ?
                <p role="alert" className="text-destructive text-sm">
                    The secrets could not be loaded: {error.message}
                </p>
            : isLoading ?
                <p className="text-muted-foreground text-sm">Loading…</p>
            : secrets.length === 0 ?
                <p className="text-muted-foreground text-sm">
                    No secrets saved for this Monitor.
                </p>
            :   <ul className="divide-y rounded-lg border">
                    {secrets.map(secret => (
                        <li
                            key={secret.id}
                            data-testid="secret-row"
                            className="space-y-2 px-3 py-2.5">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                                <KeyRound className="text-muted-foreground size-4 shrink-0" />
                                <span className="min-w-0 font-mono text-sm break-all">
                                    {secret.name}
                                </span>
                                {!usedNames || usedNames.includes(secret.name) ?
                                    null
                                :   <span className="text-muted-foreground text-xs">
                                        Not used by pre-scraping
                                    </span>}
                                <div className="ml-auto flex gap-1">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => {
                                            setReplacing(
                                                replacing === secret.name ?
                                                    null
                                                :   secret.name,
                                            );
                                            setReplacement("");
                                        }}>
                                        Replace
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-destructive hover:text-destructive"
                                        onClick={() =>
                                            setDeleting(secret.name)
                                        }>
                                        Delete
                                    </Button>
                                </div>
                            </div>
                            {replacing === secret.name ?
                                <form
                                    className="flex flex-wrap gap-2"
                                    onSubmit={event =>
                                        void replace(event, secret.name)
                                    }>
                                    <Input
                                        autoFocus
                                        type="password"
                                        autoComplete="new-password"
                                        aria-label={`New value for ${secret.name}`}
                                        placeholder="New value"
                                        className="min-w-0 flex-1"
                                        value={replacement}
                                        onChange={e =>
                                            setReplacement(e.target.value)
                                        }
                                    />
                                    <Button
                                        type="submit"
                                        size="default"
                                        disabled={replacement === ""}
                                        isLoading={putSecret.isPending}>
                                        Save the new value
                                    </Button>
                                </form>
                            :   null}
                        </li>
                    ))}
                </ul>
            }

            {adding ?
                <form
                    onSubmit={event => void add(event)}
                    className="space-y-3 rounded-lg border p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1.5">
                            <Label htmlFor="secret-name">Name</Label>
                            <Input
                                id="secret-name"
                                autoFocus
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                className="font-mono"
                                placeholder="password"
                                value={name}
                                onChange={e =>
                                    setName(e.target.value.toLowerCase())
                                }
                            />
                        </div>
                        <div className="min-w-0 space-y-1.5">
                            <Label htmlFor="secret-value">Value</Label>
                            <Input
                                id="secret-value"
                                type="password"
                                autoComplete="new-password"
                                value={value}
                                onChange={e => setValue(e.target.value)}
                            />
                        </div>
                    </div>
                    {formError ?
                        <p role="alert" className="text-destructive text-sm">
                            {formError}
                        </p>
                    :   null}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="submit"
                            size="sm"
                            isLoading={putSecret.isPending}>
                            Save the secret
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setAdding(false);
                                setFormError(null);
                            }}>
                            Cancel
                        </Button>
                    </div>
                </form>
            :   <Button
                    variant="outline"
                    size="sm"
                    data-testid="add-secret"
                    onClick={() => {
                        setAdding(true);
                        setName(missing[0] ?? "");
                    }}>
                    <Plus />
                    Add a secret
                </Button>
            }

            <AlertDialog
                open={deleting !== null}
                onOpenChange={open => {
                    if (!open) setDeleting(null);
                }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Delete the secret “{deleting}”?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleting && usedNames?.includes(deleting) ?
                                "Pre-scraping types this secret. Without it that step fails and the Monitor's Runs fail with it."
                            :   "Its value is removed for good."}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                const target = deleting;
                                setDeleting(null);
                                if (!target) return;
                                deleteSecret.mutate(target, {
                                    onSuccess: () =>
                                        toast.success(
                                            `Secret “${target}” deleted.`,
                                        ),
                                    onError: err => toast.error(err.message),
                                });
                            }}>
                            Delete the secret
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}
