"use client";

import { Button } from "@watchthatsite/ui/components/button";
import { Input } from "@watchthatsite/ui/components/input";
import { Plus, Trash2 } from "lucide-react";
import { newSecret, type SecretDraft } from "./form-state";

/**
 * Name and value rows for the secrets a new Monitor's Macro may type. Values
 * are write-only: they are sent once on save and never shown again.
 */
export function SecretFields({
    secrets,
    onChange,
}: {
    secrets: SecretDraft[];
    onChange: (secrets: SecretDraft[]) => void;
}) {
    const patch = (key: string, fields: Partial<SecretDraft>) =>
        onChange(secrets.map(s => (s.key === key ? { ...s, ...fields } : s)));

    return (
        <div className="space-y-2">
            {secrets.map((secret, i) => (
                <div
                    key={secret.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]">
                    <Input
                        aria-label={`Name of secret ${i + 1}`}
                        placeholder="password"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        className="font-mono"
                        value={secret.name}
                        onChange={e =>
                            patch(secret.key, {
                                name: e.target.value.toLowerCase(),
                            })
                        }
                    />
                    <Input
                        aria-label={`Value of secret ${i + 1}`}
                        type="password"
                        placeholder="Value"
                        autoComplete="new-password"
                        className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"
                        value={secret.value}
                        onChange={e =>
                            patch(secret.key, { value: e.target.value })
                        }
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove secret ${i + 1}`}
                        onClick={() =>
                            onChange(secrets.filter(s => s.key !== secret.key))
                        }>
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            ))}
            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange([...secrets, newSecret()])}>
                <Plus />
                Add a secret
            </Button>
        </div>
    );
}
