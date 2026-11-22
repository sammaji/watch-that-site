"use client";

import type { ChangeMonitor } from "@/hooks/use-change";
import type { ChangeRecord } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import { Label } from "@watchthatsite/ui/components/label";
import { Textarea } from "@watchthatsite/ui/components/textarea";
import { cn } from "@watchthatsite/ui/lib/utils";
import * as React from "react";
import {
    ADDED_CLASS,
    appendInstruction,
    changeSection,
    ignoreSentence,
    sectionName,
} from "./lib";

/**
 * "Ignore changes like this", inline under the Change's actions. There are
 * two ways to do it. Adding a sentence to the Instructions is always on
 * offer: it starts from a sentence built from the Change, the owner edits it
 * and sees the full Instructions it produces. When the whole Change sits in
 * one Section of the Watch Plan, ignoring that Section is offered next to it.
 */

type Route = "sentence" | "section";

function RouteOption({
    selected,
    onSelect,
    title,
    explanation,
    testId,
}: {
    selected: boolean;
    onSelect: () => void;
    title: string;
    explanation: string;
    testId: string;
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={testId}
            onClick={onSelect}
            className={cn(
                "focus-visible:ring-ring/50 flex min-w-0 items-start gap-2.5 rounded-lg border p-3 text-left outline-none focus-visible:ring-[3px]",
                selected ? "border-primary bg-primary/5" : "hover:bg-muted/40",
            )}>
            <span
                aria-hidden
                className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-primary" : "border-muted-foreground/50",
                )}>
                {selected ?
                    <span className="bg-primary size-2 rounded-full" />
                :   null}
            </span>
            <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium break-words">
                    {title}
                </span>
                <span className="text-muted-foreground block text-xs">
                    {explanation}
                </span>
            </span>
        </button>
    );
}

export function IgnoreEditor({
    record,
    summary,
    monitor,
    isSaving,
    error,
    onSaveInstructions,
    onIgnoreSection,
    onCancel,
}: {
    record: ChangeRecord | null;
    /** The Change's summary, used when the record is no longer stored. */
    summary: string;
    monitor: ChangeMonitor;
    isSaving: boolean;
    error: string | null;
    onSaveInstructions: (instructions: string) => void;
    onIgnoreSection: (sectionId: string, name: string) => void;
    onCancel: () => void;
}) {
    const plan = monitor.watch_plan;
    // Offered only when the Section still exists in the plan and is not
    // ignored already (then ignoring it again would change nothing).
    const sectionId = record ? changeSection(record, plan) : "";
    const section =
        plan?.sections.find(s => s.id === sectionId && s.how !== "ignore") ??
        null;
    const name = section ? sectionName(section.id, record, plan) : "";

    const [route, setRoute] = React.useState<Route>("sentence");
    const [sentence, setSentence] = React.useState(() =>
        ignoreSentence(record, plan, summary),
    );
    const result = appendInstruction(monitor.instructions, sentence);
    const existing = monitor.instructions.trim();

    return (
        <section
            data-testid="ignore-editor"
            aria-labelledby="ignore-heading"
            className="bg-card min-w-0 space-y-4 rounded-lg border p-4">
            <h2 id="ignore-heading" className="text-base font-medium">
                Ignore changes like this
            </h2>

            {section ?
                <div
                    role="radiogroup"
                    aria-labelledby="ignore-heading"
                    className="grid gap-2 md:grid-cols-2">
                    <RouteOption
                        testId="ignore-route-sentence"
                        selected={route === "sentence"}
                        onSelect={() => setRoute("sentence")}
                        title="Add a sentence to the Instructions"
                        explanation="The agent keeps reading that part of the page and uses your sentence to decide. Right when only some changes there are Noise."
                    />
                    <RouteOption
                        testId="ignore-route-section"
                        selected={route === "section"}
                        onSelect={() => setRoute("section")}
                        title={`Ignore the ${name} section`}
                        explanation="Nothing in that part of the page is reported again, whatever changes there. It is never sent to the model."
                    />
                </div>
            :   null}

            {route === "section" && section ?
                <p className="text-sm">
                    Changes in {name} will no longer be reported. You can turn
                    it back on under “Watching” on the Monitor page.
                </p>
            :   <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="ignore-sentence">Sentence to add</Label>
                        <Textarea
                            id="ignore-sentence"
                            className="min-h-16"
                            value={sentence}
                            onChange={e => setSentence(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <p className="text-sm font-medium">
                            Your Instructions will read
                        </p>
                        <p
                            data-testid="ignore-preview"
                            className="bg-muted/40 rounded-md border px-3 py-2 text-sm leading-6 break-words whitespace-pre-wrap">
                            {existing ?
                                <>
                                    {existing}
                                    {"\n"}
                                </>
                            :   null}
                            {sentence.trim() ?
                                <ins
                                    className={cn(ADDED_CLASS, "no-underline")}>
                                    {sentence.trim()}
                                </ins>
                            :   null}
                        </p>
                    </div>
                </div>
            }

            {error ?
                <p role="alert" className="text-destructive text-sm">
                    {error}
                </p>
            :   null}

            <div className="flex flex-wrap gap-2">
                {route === "section" && section ?
                    <Button
                        data-testid="ignore-save"
                        isLoading={isSaving}
                        onClick={() => onIgnoreSection(section.id, name)}>
                        Ignore the {name} section
                    </Button>
                :   <Button
                        data-testid="ignore-save"
                        isLoading={isSaving}
                        disabled={sentence.trim() === ""}
                        onClick={() => onSaveInstructions(result)}>
                        Save the Instructions
                    </Button>
                }
                <Button variant="ghost" disabled={isSaving} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
            <p className="text-muted-foreground text-xs">
                Either way this Change is marked as Noise, which the agent also
                learns from.
            </p>
        </section>
    );
}
