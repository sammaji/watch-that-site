"use client";

import {
    approveDraftAction,
    putSecretAction,
    startRecordingAction,
} from "@/app/actions/macros";
import { runNowAction } from "@/app/actions/scheduler";
import { useConnections } from "@/hooks/use-connections";
import { macroKeys, useMacros } from "@/hooks/use-macros";
import { useMonitors, type Monitor } from "@/hooks/use-monitors";
import { fetchUrlMetadata } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_INSTRUCTIONS, type Urgency } from "@watchthatsite/types";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@watchthatsite/ui/components/collapsible";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { Switch } from "@watchthatsite/ui/components/switch";
import { Textarea } from "@watchthatsite/ui/components/textarea";
import { cn } from "@watchthatsite/ui/lib/utils";
import { ArrowLeft, ChevronDown, Play, Sparkles } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { toast } from "sonner";
import {
    defaultModel,
    emptyForm,
    filledSecrets,
    fromMonitor,
    INTERVALS,
    isHttpUrl,
    MANUAL_INTERVAL,
    toMonitorInput,
    URGENCIES,
    validate,
    VIEWPORTS,
    viewportSize,
    type FormState,
} from "./create/form-state";
import { ModelPicker } from "./create/model-picker";
import { PagePreview } from "./create/page-preview";
import { SecretFields } from "./create/secret-fields";
import { FieldError, SwitchRow } from "./create/ui";

/**
 * Creating and editing a Monitor. Three things are asked up front (the page,
 * what to be told about, how often); the Macro and the remaining options are
 * folded away below.
 *
 * Saving a new Monitor stores its secrets, then either starts a Macro
 * recording (when a goal was given) and lands on the Macro tab, or starts the
 * first Run, which becomes the Baseline.
 */

function Disclosure({
    title,
    hint,
    defaultOpen = false,
    open: openProp,
    onOpenChange,
    control,
    children,
}: {
    title: string;
    hint?: string;
    defaultOpen?: boolean;
    /** Set to control it from outside. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Shown at the right of the header, outside the toggle area. */
    control?: React.ReactNode;
    children: React.ReactNode;
}) {
    const [ownOpen, setOwnOpen] = React.useState(defaultOpen);
    const open = openProp ?? ownOpen;
    const setOpen = onOpenChange ?? setOwnOpen;
    return (
        <Collapsible
            open={open}
            onOpenChange={setOpen}
            className="rounded-lg border">
            {/* The title and the chevron both open it; a control sits
                between them, outside either button. */}
            <div className="hover:bg-muted/40 flex items-center gap-3 rounded-lg pr-4">
                <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-3 pl-4 text-left">
                    <span className="min-w-0">
                        <span className="block text-sm font-medium">
                            {title}
                        </span>
                        {hint ?
                            <span className="text-muted-foreground block text-xs">
                                {hint}
                            </span>
                        :   null}
                    </span>
                </CollapsibleTrigger>
                {control}
                <CollapsibleTrigger
                    aria-label={open ? `Close ${title}` : `Open ${title}`}
                    tabIndex={-1}
                    className="self-stretch">
                    <ChevronDown
                        className={cn(
                            "text-muted-foreground size-4 shrink-0 transition-transform",
                            open && "rotate-180",
                        )}
                    />
                </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="space-y-5 border-t px-4 py-4">
                {children}
            </CollapsibleContent>
        </Collapsible>
    );
}

/** The "Try an example" Monitor: a careers page whose PM roles change. */
const EXAMPLE = {
    url: `${process.env.NEXT_PUBLIC_SAMPLE_PAGES_URL || "https://samplepages.wts.sammaji.com"}/test/careers`,
    instructions: "Let me know when there are new product manager roles.",
};

export function MonitorForm({ monitor }: { monitor?: Monitor }) {
    const isEdit = !!monitor;
    const router = useRouter();
    const queryClient = useQueryClient();
    const [form, setForm] = React.useState<FormState>(() =>
        monitor ? fromMonitor(monitor) : emptyForm(),
    );
    const [showErrors, setShowErrors] = React.useState(false);
    const [submitError, setSubmitError] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    // "Before each check": on when there is something to do first.
    const [macroOn, setMacroOn] = React.useState(form.goal !== "");
    const [macroOpen, setMacroOpen] = React.useState(form.goal !== "");
    // The hidden draft Monitor a recording from this form runs against,
    // made by the first Run; saving makes it the Monitor.
    const [draftId, setDraftId] = React.useState<string | null>(null);
    const [recordingId, setRecordingId] = React.useState<string | null>(null);
    const [starting, setStarting] = React.useState(false);
    // The page shown beside the form, once an address is entered.
    const [previewUrl, setPreviewUrl] = React.useState<string | null>(() =>
        monitor && isHttpUrl(monitor.url) ? monitor.url : null,
    );
    // The two-column layout: on with the preview, and off only once the
    // preview has finished animating out, so the form moves back in one go.
    const [split, setSplit] = React.useState(previewUrl !== null);
    if (previewUrl !== null && !split) setSplit(true);
    const macros = useMacros(draftId ?? undefined);
    const recorded = macros.versions.find(m => m.id === recordingId) ?? null;
    // The title last auto-filled into the name: replaced when the URL
    // changes only if the owner has not typed their own.
    const lastAutoName = React.useRef<string | null>(null);
    const titledUrl = React.useRef(monitor?.url ?? "");

    const { createMonitorAsync, updateMonitorAsync, deleteMonitorAsync } =
        useMonitors({
            pageSize: 1,
        });

    // Nothing chosen yet (a new Monitor, or one saved before any connection
    // existed): the first connection's default model is used, and shown as
    // chosen in the picker.
    const connections = useConnections();
    const chosenModel = React.useMemo(
        () =>
            form.connectionId !== null ?
                { connectionId: form.connectionId, model: form.model }
            :   (defaultModel(connections.data) ?? {
                    connectionId: null,
                    model: null,
                }),
        [form.connectionId, form.model, connections.data],
    );

    const instructionsRef = React.useRef<HTMLTextAreaElement>(null);
    /** Puts a picked element's reference at the cursor in the Instructions. */
    const mentionElement = React.useCallback((reference: string) => {
        const box = instructionsRef.current;
        // Where the cursor was when the box last had focus; the end otherwise.
        const caret = box ? box.selectionStart : null;
        setForm(f => {
            const text = f.instructions;
            const at = caret ?? text.length;
            const before = text.slice(0, at);
            const after = text.slice(at);
            const lead = before === "" || /\s$/.test(before) ? "" : " ";
            const trail = after === "" || /^\s/.test(after) ? "" : " ";
            return {
                ...f,
                instructions: `${before}${lead}${reference}${trail}${after}`,
            };
        });
        requestAnimationFrame(() => box?.focus());
    }, []);

    const errors = showErrors ? validate(form) : {};
    const change = React.useCallback(
        (patch: Partial<FormState>) => setForm(f => ({ ...f, ...patch })),
        [],
    );

    // Suggestions for this page from the account's utility model, keyed to
    // the URL they were made for; the generic examples show until then.
    const [suggested, setSuggested] = React.useState<{
        url: string;
        status: "loading" | "ready" | "failed";
        items: string[];
    } | null>(null);

    const autoName = React.useCallback((name: string | undefined) => {
        const next = name?.trim();
        if (!next) return;
        // Read outside the updater: React may run an updater twice, and it
        // must give the same answer both times.
        const previous = lastAutoName.current;
        lastAutoName.current = next;
        setForm(f => {
            const current = f.name.trim();
            if (current !== "" && current !== previous) return f;
            return { ...f, name: next };
        });
    }, []);

    /** Reads the page at the URL: its title for the name, and suggestions. */
    const readPage = React.useCallback(
        (target?: string) => {
            const url = (target ?? form.url).trim();
            if (isHttpUrl(url)) setPreviewUrl(url);
            if (!isHttpUrl(url) || url === titledUrl.current) return;
            titledUrl.current = url;
            // The name is the page's title. The quick lookup can be refused by
            // the site; then the title the worker read while rendering is used.
            let titled = false;
            fetchUrlMetadata(url)
                .then(meta => {
                    if (titledUrl.current !== url || !meta.title?.trim())
                        return;
                    titled = true;
                    autoName(meta.title);
                })
                .catch(() => {
                    // The name can be typed by hand, and falls back to the URL.
                });
            setSuggested({ url, status: "loading", items: [] });
            fetch("/api/monitors/suggest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
            })
                .then(async response => {
                    const json = (await response.json().catch(() => null)) as {
                        title?: string;
                        suggestions?: string[];
                    } | null;
                    if (!response.ok || !json?.suggestions) throw new Error();
                    // A later URL has taken over: this answer is for another page.
                    if (titledUrl.current !== url) return;
                    if (!titled) autoName(json.title);
                    setSuggested({
                        url,
                        status: "ready",
                        items: json.suggestions,
                    });
                })
                .catch(() => {
                    if (titledUrl.current !== url) return;
                    setSuggested({ url, status: "failed", items: [] });
                });
        },
        [form.url, autoName],
    );
    const pageSuggestions =
        suggested?.url === form.url.trim() ? suggested : null;

    /** Saves a draft Monitor (once) with what is filled in, and its secrets. */
    async function ensureDraft(): Promise<string> {
        const input = toMonitorInput({ ...form, ...chosenModel });
        const saved =
            draftId ?
                await updateMonitorAsync({ id: draftId, ...input })
            :   await createMonitorAsync({ ...input, status: "draft" });
        setDraftId(saved.id);
        for (const secret of macroOn && !draftId ? filledSecrets(form) : []) {
            const result = await putSecretAction(
                saved.id,
                secret.name.trim(),
                secret.value,
            );
            if (!result.ok) {
                throw new Error(
                    `The secret “${secret.name.trim()}” was not saved: ${result.error}`,
                );
            }
        }
        return saved.id;
    }

    /** Has the agent do the goal now, in the preview, recording the steps. */
    async function recordNow() {
        if (starting || recorded?.status === "recording") return;
        setShowErrors(true);
        const problems = validate(form);
        if (problems.url || problems.secrets) return;
        const goal = form.goal.trim();
        if (goal === "") {
            toast.error("Say what should happen first, then run it.");
            return;
        }
        setStarting(true);
        try {
            const id = await ensureDraft();
            const started = await startRecordingAction(id, goal);
            if (!started.ok) throw new Error(started.error);
            setRecordingId(started.data.macro_id);
            await queryClient.invalidateQueries({
                queryKey: macroKeys.list(id),
            });
        } catch (err) {
            toast.error(
                err instanceof Error ?
                    err.message
                :   "The recording did not start. Try again.",
            );
        } finally {
            setStarting(false);
        }
    }

    async function onCancel() {
        // A draft made for a recording goes with the form.
        if (draftId) await deleteMonitorAsync(draftId).catch(() => undefined);
        router.push(isEdit ? `/monitors/${monitor.id}` : "/monitors");
    }

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault();
        if (saving) return;
        setShowErrors(true);
        if (Object.keys(validate(form)).length > 0) return;

        setSaving(true);
        setSubmitError(null);
        let saved: Monitor;
        try {
            const input = toMonitorInput({ ...form, ...chosenModel });
            saved =
                monitor ? await updateMonitorAsync({ id: monitor.id, ...input })
                : draftId ?
                    await updateMonitorAsync({
                        id: draftId,
                        ...input,
                        status: "active",
                    })
                :   await createMonitorAsync(input);
        } catch (err) {
            setSubmitError(
                err instanceof Error ?
                    `The Monitor could not be saved: ${err.message}`
                :   "The Monitor could not be saved. Try again.",
            );
            setSaving(false);
            return;
        }

        if (isEdit) {
            toast.success("Monitor saved.");
            router.push(`/monitors/${saved.id}`);
            return;
        }

        // The Monitor exists from here on: whatever fails below is reported
        // on the Monitor page, where it can be retried, not by staying here.
        for (const secret of filledSecrets(form)) {
            const result = await putSecretAction(
                saved.id,
                secret.name.trim(),
                secret.value,
            );
            if (!result.ok) {
                toast.error(
                    `The secret “${secret.name.trim()}” was not saved: ${result.error} Add it again on the Pre-scraping tab.`,
                );
            }
        }

        // Recorded here: the draft the agent made becomes the Macro.
        if (macroOn && recorded?.status === "draft") {
            const approved = await approveDraftAction(saved.id, recorded.id);
            if (!approved.ok) {
                toast.error(
                    `Monitor saved, but pre-scraping was not kept: ${approved.error}`,
                );
                router.push(`/monitors/${saved.id}?tab=macro`);
                return;
            }
        } else if (macroOn && recorded?.status === "recording") {
            toast.success(
                "Monitor saved. The agent is still recording pre-scraping.",
            );
            router.push(`/monitors/${saved.id}?tab=macro`);
            return;
        }

        const goal = macroOn && !recorded ? form.goal.trim() : "";
        if (goal !== "") {
            const started = await startRecordingAction(saved.id, goal);
            if (started.ok) {
                toast.success(
                    "Monitor saved. The agent is recording pre-scraping.",
                );
            } else {
                toast.error(
                    `Monitor saved, but the recording did not start: ${started.error}`,
                );
            }
            router.push(
                `/monitors/${saved.id}?tab=macro${started.ok ? "" : `&goal=${encodeURIComponent(goal)}`}`,
            );
            return;
        }

        const run = await runNowAction(saved.id);
        if (run.ok) {
            toast.success("Monitor saved. Taking the first Capture now.");
        } else {
            toast.error(
                `Monitor saved, but the first Run did not start: ${run.error}`,
            );
        }
        router.push(`/monitors/${saved.id}`);
    }

    const secretNames = filledSecrets(form)
        .map(s => s.name.trim())
        .filter(Boolean);

    return (
        // The preview's entrance and the form's move honour reduced motion.
        <MotionConfig reducedMotion="user">
            <div
                className={cn(
                    "flex w-full min-w-0 items-start gap-6",
                    split ?
                        // Split: both halves fit the window, the form scrolls on its own.
                        "p-4 py-6 sm:p-6 lg:h-[calc(100svh-4.25rem)] lg:py-4"
                    :   "justify-center p-4 py-6 sm:p-6",
                )}>
                <motion.div
                    // Glides between centred and beside the preview.
                    layout="position"
                    transition={{ type: "spring", stiffness: 380, damping: 38 }}
                    className={cn(
                        "flex w-full max-w-2xl min-w-0 flex-col gap-6",
                        split &&
                            "lg:-my-4 lg:h-[calc(100%+2rem)] lg:w-[34rem] lg:shrink-0 lg:overflow-y-auto lg:py-4 lg:pr-2 xl:w-[38rem]",
                    )}>
                    <div className="flex flex-col gap-2">
                        <Link
                            href={
                                isEdit ? `/monitors/${monitor.id}` : "/monitors"
                            }
                            className="text-muted-foreground hover:text-foreground flex w-fit max-w-full items-center gap-1 text-sm">
                            <ArrowLeft className="size-4 shrink-0" />
                            <span className="truncate">
                                {isEdit ? monitor.name : "Monitors"}
                            </span>
                        </Link>
                        <h1 className="text-2xl font-semibold tracking-tight">
                            {isEdit ? "Edit Monitor" : "New Monitor"}
                        </h1>
                    </div>

                    <form
                        noValidate
                        onSubmit={onSubmit}
                        className="flex min-w-0 flex-col gap-6">
                        <div className="space-y-2">
                            <Label htmlFor="monitor-url">Page to watch</Label>
                            <Input
                                id="monitor-url"
                                type="url"
                                inputMode="url"
                                autoComplete="off"
                                placeholder="https://example.com/pricing"
                                aria-invalid={!!errors.url}
                                value={form.url}
                                onChange={e => {
                                    change({ url: e.target.value });
                                    // No address, no preview.
                                    if (e.target.value.trim() === "") {
                                        setPreviewUrl(null);
                                    }
                                }}
                                onBlur={() => readPage()}
                            />
                            <FieldError message={errors.url} />
                            {isEdit ? null : (
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        data-testid="try-example"
                                        onClick={() => {
                                            change({
                                                url: EXAMPLE.url,
                                                instructions:
                                                    EXAMPLE.instructions,
                                            });
                                            readPage(EXAMPLE.url);
                                        }}
                                        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
                                        Try an example
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="monitor-name">Name</Label>
                            <Input
                                id="monitor-name"
                                placeholder="Filled in from the page's title"
                                aria-invalid={!!errors.name}
                                value={form.name}
                                onChange={e => change({ name: e.target.value })}
                            />
                            <FieldError message={errors.name} />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="monitor-instructions">
                                What should we tell you about?
                            </Label>
                            <Textarea
                                ref={instructionsRef}
                                id="monitor-instructions"
                                className="min-h-28"
                                placeholder={DEFAULT_INSTRUCTIONS}
                                value={form.instructions}
                                onChange={e =>
                                    change({ instructions: e.target.value })
                                }
                            />
                            <div
                                className="flex flex-col items-start gap-1.5"
                                aria-label={"Suggestions for this page"}
                                aria-busy={
                                    pageSuggestions?.status === "loading"
                                }>
                                {(
                                    pageSuggestions?.status === "loading" ||
                                    pageSuggestions?.status === "ready"
                                ) ?
                                    <span
                                        data-testid={
                                            (
                                                pageSuggestions.status ===
                                                "loading"
                                            ) ?
                                                "suggestions-loading"
                                            :   undefined
                                        }
                                        className={cn(
                                            "text-muted-foreground flex items-center gap-1 text-xs",
                                            pageSuggestions.status ===
                                                "loading" && "shimmer-text",
                                        )}>
                                        <Sparkles className="text-muted-foreground size-3.5" />
                                        For this page
                                    </span>
                                :   null}
                                {(pageSuggestions?.status === "ready" ?
                                    pageSuggestions.items
                                :   []
                                ).map(example => (
                                    <button
                                        key={example}
                                        type="button"
                                        data-testid="instruction-example"
                                        onClick={() =>
                                            change({ instructions: example })
                                        }
                                        className="hover:bg-muted text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 max-w-full rounded-full border px-2.5 py-1 text-left text-xs outline-none focus-visible:ring-[3px]">
                                        {example}
                                    </button>
                                ))}
                            </div>
                            <p className="text-muted-foreground text-xs">
                                Say what matters and what to ignore, in your own
                                words. Leave it empty to hear about any
                                meaningful change. After the first check,
                                we&apos;ll show you how the page was divided up
                                and what is watched in each part. You can change
                                it.
                            </p>
                        </div>

                        <ModelPicker
                            connectionId={chosenModel.connectionId}
                            model={chosenModel.model}
                            onChange={change}
                        />

                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="min-w-0 space-y-2">
                                <Label htmlFor="monitor-interval">
                                    How often
                                </Label>
                                <Select
                                    value={form.interval}
                                    onValueChange={interval =>
                                        change({ interval })
                                    }>
                                    <SelectTrigger
                                        id="monitor-interval"
                                        className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {INTERVALS.map(i => (
                                            <SelectItem
                                                key={i.value}
                                                value={i.value}>
                                                {i.label}
                                            </SelectItem>
                                        ))}
                                        {(
                                            form.interval !== MANUAL_INTERVAL &&
                                            !INTERVALS.some(
                                                i => i.value === form.interval,
                                            )
                                        ) ?
                                            <SelectItem value={form.interval}>
                                                Every {form.interval} minutes
                                            </SelectItem>
                                        :   null}
                                        <SelectItem value={MANUAL_INTERVAL}>
                                            Only when I run it
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="min-w-0 space-y-2">
                                <Label htmlFor="viewport">Browser size</Label>
                                <Select
                                    value={form.viewport}
                                    onValueChange={viewport =>
                                        change({ viewport })
                                    }>
                                    <SelectTrigger
                                        id="viewport"
                                        className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {VIEWPORTS.map(v => (
                                            <SelectItem
                                                key={v.value}
                                                value={v.value}>
                                                {v.label}
                                            </SelectItem>
                                        ))}
                                        {form.customViewport ?
                                            <SelectItem value="custom">
                                                Custom (
                                                {form.customViewport.width} ×{" "}
                                                {form.customViewport.height})
                                            </SelectItem>
                                        :   null}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        {isEdit ?
                            <p className="text-muted-foreground rounded-lg border px-4 py-3 text-sm">
                                Pre-scraping, which runs before each check, and
                                the secrets it types, are on the{" "}
                                <Link
                                    href={`/monitors/${monitor.id}?tab=macro`}
                                    className="text-foreground font-medium underline underline-offset-2">
                                    Pre-scraping tab
                                </Link>
                                .
                            </p>
                        :   <Disclosure
                                title="Before each check"
                                open={macroOn && macroOpen}
                                onOpenChange={next => {
                                    if (next && !macroOn) setMacroOn(true);
                                    setMacroOpen(next);
                                }}
                                control={
                                    <Switch
                                        aria-label="Do something before each check"
                                        checked={macroOn}
                                        onCheckedChange={on => {
                                            setMacroOn(on);
                                            setMacroOpen(on);
                                        }}
                                    />
                                }>
                                <div className="space-y-2">
                                    <Label htmlFor="monitor-goal">
                                        What should happen first?
                                    </Label>
                                    <Textarea
                                        id="monitor-goal"
                                        className="min-h-20"
                                        placeholder="Sign in, open Billing, switch to Annual"
                                        value={form.goal}
                                        onChange={e =>
                                            change({ goal: e.target.value })
                                        }
                                    />
                                </div>
                                <div className="space-y-2">
                                    <p className="text-sm font-medium">
                                        Secrets
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        Passwords and the like. They are stored
                                        encrypted, typed into the page by the
                                        browser, never shown again and only the
                                        name is sent to the model.
                                    </p>
                                    <SecretFields
                                        secrets={form.secrets}
                                        onChange={secrets =>
                                            change({ secrets })
                                        }
                                    />
                                    <FieldError message={errors.secrets} />
                                </div>
                                <div className="flex flex-wrap items-center gap-3">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        data-testid="record-now"
                                        isLoading={starting}
                                        disabled={
                                            recorded?.status === "recording" ||
                                            form.goal.trim() === ""
                                        }
                                        onClick={recordNow}>
                                        <Play />
                                        {recorded ? "Run again" : "Run"}
                                    </Button>
                                    <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                                        {recorded?.status === "recording" ?
                                            "The agent is doing it now. Watch it in the preview."
                                        : recorded?.status === "draft" ?
                                            `Recorded ${recorded.steps.length} step${recorded.steps.length === 1 ? "" : "s"}. They run before each check once you save.`
                                        : recorded?.status === "failed" ?
                                            "The agent could not do it. Change the goal and run again."
                                        :   "The agent does this now in a fresh browser, and you watch it in the preview. Or save, and it records the steps then."
                                        }
                                    </p>
                                </div>
                            </Disclosure>
                        }

                        <Disclosure title="Advanced">
                            <SwitchRow
                                id="confirm-changes"
                                label="Confirm before alerting"
                                description="A Change must still be there on the next Run, a few minutes later, before you are told. Filters out things that flicker."
                                checked={form.confirmChanges}
                                onChange={confirmChanges =>
                                    change({ confirmChanges })
                                }
                            />

                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="min-w-0 space-y-2">
                                    <Label htmlFor="urgency">Tell me</Label>
                                    <Select
                                        value={form.urgency}
                                        onValueChange={value =>
                                            change({
                                                urgency: value as Urgency,
                                            })
                                        }>
                                        <SelectTrigger
                                            id="urgency"
                                            className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {URGENCIES.map(u => (
                                                <SelectItem
                                                    key={u.value}
                                                    value={u.value}>
                                                    {u.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-muted-foreground text-xs">
                                        {
                                            URGENCIES.find(
                                                u => u.value === form.urgency,
                                            )?.hint
                                        }
                                    </p>
                                </div>
                            </div>

                            <SwitchRow
                                id="block-ads"
                                label="Block ads and trackers"
                                description="Ads change on every load and would show up as differences."
                                checked={form.blockAds}
                                onChange={blockAds => change({ blockAds })}
                            />
                        </Disclosure>

                        {submitError ?
                            <div
                                role="alert"
                                className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
                                {submitError}
                            </div>
                        : showErrors && Object.keys(errors).length > 0 ?
                            <p
                                role="alert"
                                className="text-destructive text-sm">
                                Fix the highlighted fields to save.
                            </p>
                        :   null}

                        <div className="flex flex-wrap gap-2 border-t pt-4">
                            <Button type="submit" isLoading={saving}>
                                {isEdit ?
                                    "Save Monitor"
                                : macroOn && recorded?.status === "draft" ?
                                    "Save and run the first check"
                                : macroOn && !recorded && form.goal.trim() ?
                                    "Save and record pre-scraping"
                                :   "Save and run the first check"}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={onCancel}>
                                Cancel
                            </Button>
                        </div>
                    </form>
                </motion.div>
                <AnimatePresence onExitComplete={() => setSplit(false)}>
                    {previewUrl ?
                        <motion.aside
                            key="preview"
                            initial={{ opacity: 0, x: 32, scale: 0.98 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 32, scale: 0.98 }}
                            transition={{
                                duration: 0.28,
                                ease: [0.22, 1, 0.36, 1],
                            }}
                            className="hidden h-full min-w-0 flex-1 origin-left lg:block">
                            <PagePreview
                                url={previewUrl}
                                macro={recorded}
                                size={viewportSize(form)}
                                onPick={mentionElement}
                            />
                        </motion.aside>
                    :   null}
                </AnimatePresence>
            </div>
        </MotionConfig>
    );
}
