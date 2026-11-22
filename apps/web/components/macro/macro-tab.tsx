"use client";

import { runNowAction } from "@/app/actions/scheduler";
import { TraceStep } from "@/components/monitor/run-trace";
import { Entity } from "@/hooks/keys";
import {
    isStaleRecording,
    useMacroMutations,
    useMacros,
    useMonitorSecrets,
} from "@/hooks/use-macros";
import type { Monitor } from "@/hooks/use-monitors";
import { useLastReplay, useRecordingSteps } from "@/hooks/use-run-steps";
import { useQueryClient } from "@tanstack/react-query";
import { secretNames, type Macro, type MacroStep } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import { Label } from "@watchthatsite/ui/components/label";
import { Textarea } from "@watchthatsite/ui/components/textarea";
import {
    Bot,
    ChevronDown,
    CircleAlert,
    LoaderCircle,
    Pencil,
} from "lucide-react";
import Link from "next/link";
import React from "react";
import { toast } from "sonner";
import { SecretsPanel } from "./secrets-panel";
import { StepEditor } from "./step-editor";
import { StepList, type StepOutcome } from "./step-list";
import { VersionHistory } from "./version-history";

/**
 * The Macro tab of the Monitor page: the active version as a step list,
 * recording with the agent (live), a draft waiting for approval, a failed
 * recording, editing the steps by hand with a test replay, the secrets the
 * Macro types, and the version history.
 */

/** What the editor was opened on. */
type Editing = { steps: MacroStep[]; fromDraftId?: string };

function RecordForm({
    monitor,
    initialGoal,
    isStarting,
    onStart,
    onCancel,
}: {
    monitor: Monitor;
    initialGoal: string;
    isStarting: boolean;
    onStart: (goal: string) => void;
    onCancel?: () => void;
}) {
    const [goal, setGoal] = React.useState(initialGoal);
    const canRecord = !!monitor.connection_id;
    return (
        <form
            className="space-y-3"
            onSubmit={event => {
                event.preventDefault();
                if (goal.trim()) onStart(goal.trim());
            }}>
            <div className="space-y-1.5">
                <Label htmlFor="macro-goal">
                    What should happen before each check?
                </Label>
                <Textarea
                    id="macro-goal"
                    className="min-h-20"
                    placeholder="Sign in, open Billing, switch to Annual"
                    value={goal}
                    onChange={e => setGoal(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                    The agent opens {monitor.url} in a fresh browser, works out
                    the steps and shows them to you. Nothing is replayed on your
                    Monitor until you approve them. Mention saved secrets by
                    name.
                </p>
            </div>
            {canRecord ? null : (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    Recording needs a model, and this Monitor has none.{" "}
                    <Link
                        href={`/monitors/edit/${monitor.id}`}
                        className="font-medium underline underline-offset-2">
                        Choose one under Edit → More options
                    </Link>
                    , or write the steps by hand.
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    type="submit"
                    data-testid="record-with-agent"
                    isLoading={isStarting}
                    disabled={!canRecord || goal.trim() === ""}>
                    {isStarting ? null : <Bot />}
                    Record with the agent
                </Button>
                {onCancel ?
                    <Button type="button" variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                :   null}
            </div>
        </form>
    );
}

/** A recording in flight, a draft waiting for approval, or a failed recording. */
function PendingPanel({
    macro,
    busy,
    onApprove,
    onEdit,
    onDiscard,
    onRetry,
}: {
    macro: Macro;
    busy: boolean;
    onApprove: () => void;
    onEdit: () => void;
    onDiscard: () => void;
    onRetry: () => void;
}) {
    const recording = macro.status === "recording";
    const [now] = React.useState(() => Date.now());
    const stale = isStaleRecording(macro, now);
    const { steps } = useRecordingSteps(macro.id, recording && !stale);
    const [showTrace, setShowTrace] = React.useState(false);
    const last = steps[steps.length - 1];

    const trace = (
        <ol className="divide-y">
            {steps.map(step => (
                <TraceStep key={step.id} step={step} />
            ))}
        </ol>
    );

    if (recording) {
        return (
            <section
                data-testid="macro-recording"
                aria-live="polite"
                className="space-y-3 rounded-lg border border-sky-500/40 bg-sky-500/5 p-4">
                <div className="space-y-1">
                    <h3 className="flex items-center gap-2 text-base font-medium">
                        {stale ?
                            <CircleAlert className="size-4 text-amber-600" />
                        :   <LoaderCircle className="size-4 animate-spin" />}
                        {stale ?
                            "This recording stopped responding"
                        :   "The agent is recording pre-scraping"}
                    </h3>
                    <p className="text-muted-foreground text-sm break-words">
                        Goal: {macro.goal}
                    </p>
                    {stale ?
                        <p className="text-sm">
                            Nothing has happened for over ten minutes. Discard
                            it and record again.
                        </p>
                    : last ?
                        <p className="text-sm">
                            Step {steps.length}: {last.title}
                        </p>
                    :   <p className="text-sm">
                            Opening the page in a fresh browser…
                        </p>
                    }
                </div>
                {steps.length ? trace : null}
                {stale ?
                    <Button
                        variant="outline"
                        size="sm"
                        isLoading={busy}
                        onClick={onDiscard}>
                        Discard this recording
                    </Button>
                :   null}
            </section>
        );
    }

    if (macro.status === "failed") {
        return (
            <section
                data-testid="macro-failed"
                className="border-destructive/40 bg-destructive/5 space-y-3 rounded-lg border p-4">
                <div className="space-y-1">
                    <h3 className="flex items-center gap-2 text-base font-medium">
                        <CircleAlert className="text-destructive size-4" />
                        The agent could not record pre-scraping
                    </h3>
                    <p className="text-muted-foreground text-sm break-words">
                        Goal: {macro.goal}
                    </p>
                    <p className="text-sm break-words">
                        {macro.note ||
                            "It stopped without saying why. Try again, or write the steps by hand."}
                    </p>
                </div>
                {steps.length ?
                    <details className="text-sm">
                        <summary className="text-muted-foreground cursor-pointer">
                            What the agent did before it stopped ({steps.length}{" "}
                            step{steps.length === 1 ? "" : "s"})
                        </summary>
                        {trace}
                    </details>
                :   null}
                <div className="flex flex-wrap gap-2">
                    <Button
                        data-testid="retry-recording"
                        isLoading={busy}
                        onClick={onRetry}>
                        Try again
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={onDiscard}>
                        Discard
                    </Button>
                </div>
            </section>
        );
    }

    // A draft: nothing is replayed on the Monitor until the owner approves.
    return (
        <section
            data-testid="macro-draft"
            className="space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4">
            <div className="space-y-1">
                <h3 className="text-base font-medium">
                    The agent recorded pre-scraping. Approve it to start using
                    it.
                </h3>
                <p className="text-muted-foreground text-sm break-words">
                    Goal: {macro.goal}
                </p>
                {macro.note ?
                    <p className="text-sm break-words">{macro.note}</p>
                :   null}
            </div>
            <StepList steps={macro.steps} />
            {steps.length ?
                <div>
                    <button
                        type="button"
                        aria-expanded={showTrace}
                        onClick={() => setShowTrace(v => !v)}
                        className="text-muted-foreground hover:text-foreground flex items-start gap-1 text-left text-sm">
                        <ChevronDown
                            className={
                                showTrace ?
                                    "mt-0.5 size-4 shrink-0 rotate-180 transition-transform"
                                :   "mt-0.5 size-4 shrink-0 transition-transform"
                            }
                        />
                        What the agent did while recording, with screenshots
                    </button>
                    {showTrace ? trace : null}
                </div>
            :   null}
            <div className="flex flex-wrap gap-2">
                <Button
                    data-testid="approve-macro"
                    isLoading={busy}
                    onClick={onApprove}>
                    Approve this pre-scraping
                </Button>
                <Button variant="outline" disabled={busy} onClick={onEdit}>
                    <Pencil />
                    Edit the steps first
                </Button>
                <Button variant="ghost" disabled={busy} onClick={onDiscard}>
                    Discard
                </Button>
            </div>
        </section>
    );
}

export function MacroTab({
    monitor,
    initialGoal = "",
}: {
    monitor: Monitor;
    /** A goal carried over from the create form when recording did not start. */
    initialGoal?: string;
}) {
    const queryClient = useQueryClient();
    const { versions, active, pending, isLoading, error } = useMacros(
        monitor.id,
    );
    const { secrets } = useMonitorSecrets(monitor.id);
    const mutations = useMacroMutations(monitor.id);
    const replay = useLastReplay(active?.id);
    const [editing, setEditing] = React.useState<Editing | null>(null);
    const [recordAgain, setRecordAgain] = React.useState(false);

    // How each step of the active version went on the last Run that
    // replayed it. Repairs sit between the Macro steps and are skipped here.
    const outcomes = React.useMemo<StepOutcome[]>(
        () =>
            (replay?.steps ?? [])
                .filter(step => step.phase === "macro")
                .map(step => ({
                    status: step.status,
                    screenshotKey: step.screenshot_key,
                })),
        [replay],
    );

    /**
     * A new active version changes what is captured, so the next Run takes
     * a fresh Baseline. Start it now rather than leaving the Monitor
     * comparing against a page the Macro no longer produces.
     */
    async function rebaseline(what: string) {
        const run = await runNowAction(monitor.id);
        void queryClient.invalidateQueries({ queryKey: [Entity.monitorRun] });
        if (run.ok) {
            toast.success(
                `${what} A Run has started to take a new Baseline with it.`,
            );
        } else {
            toast.success(
                `${what} Press “Run now” to take a new Baseline with it.`,
            );
        }
    }

    function start(goal: string) {
        mutations.startRecording.mutate(goal, {
            onSuccess: () => setRecordAgain(false),
            onError: err => toast.error(err.message),
        });
    }

    function discard(macroId: string) {
        mutations.discard.mutate(macroId, {
            onError: err => toast.error(err.message),
        });
    }

    if (isLoading) {
        return (
            <p className="text-muted-foreground py-8 text-center text-sm">
                Loading pre-scraping…
            </p>
        );
    }
    if (error) {
        return (
            <p role="alert" className="text-destructive text-sm">
                Pre-scraping could not be loaded: {error.message}
            </p>
        );
    }

    if (editing) {
        return (
            <section aria-label="Edit steps by hand" className="space-y-4">
                <div className="space-y-1">
                    <h2 className="text-lg font-medium">Edit steps by hand</h2>
                    <p className="text-muted-foreground text-sm">
                        Saving makes these steps the version in use. The earlier
                        one stays in the history.
                    </p>
                </div>
                <StepEditor
                    monitorId={monitor.id}
                    initialSteps={editing.steps}
                    savedSecrets={secrets.map(s => s.name)}
                    isSaving={mutations.saveSteps.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={steps =>
                        mutations.saveSteps.mutate(
                            { steps, fromDraftId: editing.fromDraftId },
                            {
                                onSuccess: saved => {
                                    setEditing(null);
                                    void rebaseline(
                                        `Saved as version ${saved.version}.`,
                                    );
                                },
                                onError: err => toast.error(err.message),
                            },
                        )
                    }
                />
                <SecretsPanel monitorId={monitor.id} />
            </section>
        );
    }

    const busy =
        mutations.approveDraft.isPending ||
        mutations.discard.isPending ||
        mutations.startRecording.isPending;
    const showRecordForm = !pending && (recordAgain || !active);

    return (
        <section aria-label="Pre-scraping" className="space-y-6">
            <div className="space-y-1">
                <h2 className="text-lg font-medium">Pre-scraping</h2>
                <p className="text-muted-foreground text-sm">
                    Browser actions replayed before each Capture, so the page is
                    in the state you want watched: signed in, a tab opened, a
                    filter set. Replay uses no model. When a step stops working,
                    the agent repairs it and tells you.
                </p>
            </div>

            {pending ?
                <PendingPanel
                    macro={pending}
                    busy={busy}
                    onApprove={() =>
                        mutations.approveDraft.mutate(pending.id, {
                            onSuccess: () =>
                                void rebaseline("Pre-scraping approved."),
                            onError: err => toast.error(err.message),
                        })
                    }
                    onEdit={() =>
                        setEditing({
                            steps: pending.steps,
                            fromDraftId: pending.id,
                        })
                    }
                    onDiscard={() => discard(pending.id)}
                    onRetry={() => {
                        const goal = pending.goal;
                        mutations.discard.mutate(pending.id, {
                            onSuccess: () => start(goal),
                            onError: err => toast.error(err.message),
                        });
                    }}
                />
            :   null}

            {active ?
                <div className="space-y-3" data-testid="macro-active">
                    <StepList steps={active.steps} outcomes={outcomes} />
                </div>
            : pending ?
                null
            :   <p className="text-muted-foreground rounded-md border border-dashed px-4 py-6 text-center text-sm">
                    This Monitor has no pre-scraping: the page is captured as it
                    loads. Add it if the page needs signing in or a few clicks
                    first.
                </p>
            }

            {showRecordForm ?
                <div className="space-y-3 rounded-lg border p-4">
                    <RecordForm
                        monitor={monitor}
                        initialGoal={active?.goal || initialGoal}
                        isStarting={mutations.startRecording.isPending}
                        onStart={start}
                        onCancel={
                            active ? () => setRecordAgain(false) : undefined
                        }
                    />
                    {active ? null : (
                        <p className="text-muted-foreground text-sm">
                            Prefer to do it yourself?{" "}
                            <button
                                type="button"
                                data-testid="write-steps"
                                onClick={() => setEditing({ steps: [] })}
                                className="text-foreground font-medium underline underline-offset-2">
                                Write the steps by hand
                            </button>
                            .
                        </p>
                    )}
                </div>
            :   null}

            <SecretsPanel
                monitorId={monitor.id}
                usedNames={secretNames(active?.steps ?? pending?.steps ?? [])}
            />

            <VersionHistory versions={versions} />
        </section>
    );
}
