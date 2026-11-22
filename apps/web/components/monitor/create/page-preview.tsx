"use client";

import { ObjectImage } from "@/components/change/object-image";
import { useRecordingSteps } from "@/hooks/use-run-steps";
import type { Macro } from "@watchthatsite/types";
import { cn } from "@watchthatsite/ui/lib/utils";
import {
    Bot,
    CircleAlert,
    CircleCheck,
    Globe,
    LoaderCircle,
    Maximize2,
    Minimize2,
    RotateCw,
    SquareMousePointer,
} from "lucide-react";
import React from "react";
import { isHttpUrl } from "./form-state";

/**
 * Where the web app serves a page through the preview proxy, which rewrites
 * it to load inside an iframe. The route needs a signed-in session.
 */
export function proxyPath(url: string): string | null {
    if (!isHttpUrl(url)) return null;
    const u = new URL(url);
    const scheme = u.protocol.replace(":", "");
    // No trailing slash for the root: Next.js would redirect it.
    const path = u.pathname === "/" ? "" : u.pathname;
    return `/api/v1/proxy/${scheme}/${u.host}${path}${u.search}`;
}

type View = "page" | "agent";

/** Messages of the proxy's injected runtime (services/proxy/runtime.go). */
const SET_MODE = "msg:set-mode";
const SELECTION = "msg:selection";
const MODE_CHANGED = "msg:mode-changed";
const SET_SCALE = "msg:set-scale";

/** An XPath as the plan's outline writes it: no `/html/body`, no `[1]`. */
export function shortPath(path: string): string {
    const rest = path.replace(/^\/html\[1\]\/body\[1\]/, "");
    const short = rest.replace(/\[1\](?=\/|$)/g, "").replace(/^\//, "");
    return short === "" ? "body" : short;
}

/** How a picked element is written into the Instructions: `@[text](path)`. */
export function elementReference(text: string, path: string): string {
    const words = text.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
    const label =
        words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words;
    return `@[${label}](${shortPath(path)})`;
}

/**
 * The right half of the Monitor form: the page as it is now, through the
 * proxy, and, once the agent is recording a Macro, what the agent sees and
 * does, step by step, from the screenshots it takes after each action.
 */
export function PagePreview({
    url,
    macro,
    size,
    onPick,
}: {
    url: string;
    /** The recording started from this form, if any. */
    macro: Macro | null;
    /** The Monitor's browser size: the page is laid out at this width. */
    size: { width: number; height: number };
    /** Called with `@[text](path)` when an element is picked on the page. */
    onPick?: (reference: string) => void;
}) {
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const [picking, setPicking] = React.useState(false);
    // The page is shown scaled; the picker's outline and label are drawn
    // at 1/scale inside it so they keep their size on screen.
    const [scale, setScale] = React.useState(1);
    const onPickRef = React.useRef(onPick);
    React.useEffect(() => {
        onPickRef.current = onPick;
    }, [onPick]);
    const setMode = React.useCallback((mode: "selection" | "none") => {
        frameRef.current?.contentWindow?.postMessage(
            { type: SET_MODE, payload: { mode } },
            "*",
        );
    }, []);
    React.useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            if (event.source !== frameRef.current?.contentWindow) return;
            const data = event.data as {
                type?: string;
                payload?: {
                    mode?: string;
                    tagName?: string;
                    textAnchor?: string;
                    full_xpath?: string;
                };
            } | null;
            if (data?.type === MODE_CHANGED) {
                setPicking(data.payload?.mode === "selection");
            } else if (data?.type === SELECTION && data.payload?.full_xpath) {
                const p = data.payload;
                onPickRef.current?.(
                    elementReference(
                        p.textAnchor || p.tagName || "element",
                        p.full_xpath!,
                    ),
                );
                // One pick per press, like a browser's element picker.
                setMode("none");
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [setMode]);
    React.useEffect(() => {
        if (!picking) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMode("none");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [picking, setMode]);
    const sectionRef = React.useRef<HTMLElement>(null);
    const [fullscreen, setFullscreen] = React.useState(false);
    React.useEffect(() => {
        const sync = () =>
            setFullscreen(document.fullscreenElement === sectionRef.current);
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);
    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else
            void sectionRef.current?.requestFullscreen().catch(() => undefined);
    };
    const src = proxyPath(url.trim());
    const [view, setView] = React.useState<View>("page");
    const [reload, setReload] = React.useState(0);
    const [loaded, setLoaded] = React.useState<string | null>(null);
    // Tell the page its scale when it loads and whenever the pane resizes.
    React.useEffect(() => {
        if (!loaded) return;
        frameRef.current?.contentWindow?.postMessage(
            { type: SET_SCALE, payload: { scale } },
            "*",
        );
    }, [scale, loaded]);

    // A new recording brings its view to the front.
    const [shownMacro, setShownMacro] = React.useState<string | null>(null);
    if (macro && macro.id !== shownMacro) {
        setShownMacro(macro.id);
        setView("agent");
    }

    const tabs: { id: View; label: string; icon: typeof Globe }[] = [
        { id: "page", label: "Page", icon: Globe },
        ...(macro ? [{ id: "agent" as const, label: "Agent", icon: Bot }] : []),
    ];

    return (
        <section
            ref={sectionRef}
            aria-label="Preview"
            className="bg-card flex h-full min-h-0 flex-col overflow-hidden rounded-lg border">
            <div className="flex items-center gap-1 border-b px-2 py-1.5">
                {onPick && view === "page" && src ?
                    <button
                        type="button"
                        aria-label={
                            picking ? "Stop selecting" : (
                                "Select an element to mention it"
                            )
                        }
                        title="Select an element on the page to mention it in what to tell you about"
                        aria-pressed={picking}
                        disabled={loaded !== `${src}#${reload}`}
                        onClick={() => setMode(picking ? "none" : "selection")}
                        className={cn(
                            "rounded-md p-1.5 disabled:opacity-40",
                            picking ?
                                "bg-sky-500/15 text-sky-600"
                            :   "text-muted-foreground hover:text-foreground hover:bg-muted",
                        )}>
                        <SquareMousePointer className="size-3.5" />
                    </button>
                :   null}
                <div role="tablist" className="flex gap-1">
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={view === t.id}
                            onClick={() => setView(t.id)}
                            className={cn(
                                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                                view === t.id ?
                                    "bg-muted text-foreground font-medium"
                                :   "text-muted-foreground hover:text-foreground",
                            )}>
                            <t.icon className="size-3.5" />
                            {t.label}
                            {t.id === "agent" && macro?.status === "recording" ?
                                <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
                            :   null}
                        </button>
                    ))}
                </div>
                <div className="ml-auto flex items-center gap-1">
                    {view === "page" && src ?
                        <>
                            <span className="text-muted-foreground px-1 text-xs tabular-nums">
                                {size.width} × {size.height}
                            </span>
                            <button
                                type="button"
                                aria-label="Reload the page"
                                onClick={() => {
                                    setLoaded(null);
                                    setReload(r => r + 1);
                                }}
                                className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md p-1.5">
                                <RotateCw className="size-3.5" />
                            </button>
                        </>
                    :   null}
                    <button
                        type="button"
                        aria-label={
                            fullscreen ? "Exit full screen" : "Full screen"
                        }
                        aria-pressed={fullscreen}
                        onClick={toggleFullscreen}
                        className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md p-1.5">
                        {fullscreen ?
                            <Minimize2 className="size-3.5" />
                        :   <Maximize2 className="size-3.5" />}
                    </button>
                </div>
            </div>

            <div className="relative min-h-0 flex-1">
                {view === "agent" && macro ?
                    <AgentView macro={macro} />
                : src ?
                    <>
                        {loaded !== `${src}#${reload}` ?
                            <div className="text-muted-foreground bg-card absolute inset-0 z-10 flex items-center justify-center gap-2 text-sm">
                                <LoaderCircle className="size-4 animate-spin" />
                                Loading the page…
                            </div>
                        :   null}
                        <ScaledFrame size={size} onScale={setScale}>
                            <iframe
                                ref={frameRef}
                                key={`${src}#${reload}`}
                                src={src}
                                title="The page to watch"
                                // Scripts run so the page renders as it does
                                // in a browser; it stays on the proxy origin.
                                sandbox="allow-scripts allow-same-origin allow-forms"
                                onLoad={() => {
                                    setLoaded(`${src}#${reload}`);
                                    setPicking(false);
                                }}
                                className="block size-full bg-white"
                            />
                        </ScaledFrame>
                    </>
                :   <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
                        <Globe className="size-6" />
                        Enter the page&apos;s address to see it here.
                    </div>
                }
            </div>
        </section>
    );
}

/**
 * Shows its child at the browser's size, scaled down to the pane's width
 * when wider, so the page lays out as it will in a Run; the page scrolls
 * inside. Narrower than the pane (a phone), it is centred. Below it the pane
 * stays empty.
 */
function ScaledFrame({
    size,
    onScale,
    children,
}: {
    size: { width: number; height: number };
    onScale?: (scale: number) => void;
    children: React.ReactNode;
}) {
    const boxRef = React.useRef<HTMLDivElement>(null);
    const [box, setBox] = React.useState<{ w: number; h: number } | null>(null);
    React.useEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => {
            const r = entry!.contentRect;
            setBox({ w: r.width, h: r.height });
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const scale = box ? Math.min(1, box.w / size.width) : 1;
    React.useEffect(() => {
        onScale?.(scale);
    }, [scale, onScale]);
    return (
        <div
            ref={boxRef}
            className="bg-muted/40 absolute inset-0 flex justify-center overflow-hidden">
            {box ?
                <div
                    style={{
                        width: size.width * scale,
                        height: Math.min(size.height * scale, box.h),
                    }}
                    className="relative shrink-0 overflow-hidden border-b shadow-sm">
                    <div
                        style={{
                            width: size.width,
                            height: size.height,
                            transform: `scale(${scale})`,
                            transformOrigin: "0 0",
                        }}>
                        {children}
                    </div>
                </div>
            :   null}
        </div>
    );
}

/** The agent's recording: its latest screenshot, large, and its steps. */
function AgentView({ macro }: { macro: Macro }) {
    const recording = macro.status === "recording";
    const { steps } = useRecordingSteps(macro.id, recording);
    const shots = steps.filter(s => s.screenshot_key);
    const [picked, setPicked] = React.useState<string | null>(null);
    // Follow the newest screenshot unless the owner picked an earlier step.
    const shown =
        shots.find(s => s.id === picked) ?? shots[shots.length - 1] ?? null;
    const listRef = React.useRef<HTMLOListElement>(null);
    React.useEffect(() => {
        if (!picked) {
            listRef.current?.lastElementChild?.scrollIntoView({
                block: "nearest",
            });
        }
    }, [steps.length, picked]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div
                aria-live="polite"
                className={cn(
                    "flex items-start gap-2 border-b px-3 py-2 text-sm",
                    recording ? "bg-sky-500/5"
                    : macro.status === "failed" ? "bg-destructive/5"
                    : "bg-emerald-500/5",
                )}>
                {recording ?
                    <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-sky-600" />
                : macro.status === "failed" ?
                    <CircleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
                :   <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                }
                <div className="min-w-0">
                    <p className="font-medium">
                        {recording ?
                            steps.length ?
                                `Step ${steps.length}: ${steps[steps.length - 1]!.title}`
                            :   "Opening the page in a fresh browser…"
                        : macro.status === "failed" ?
                            "The agent could not record this"
                        :   `Recorded ${macro.steps.length} step${macro.steps.length === 1 ? "" : "s"}. Saving the Monitor uses them before each check.`
                        }
                    </p>
                    {macro.status === "failed" && macro.note ?
                        <p className="text-muted-foreground text-xs break-words">
                            {macro.note}
                        </p>
                    :   null}
                </div>
            </div>

            <div className="bg-muted/40 relative flex min-h-0 flex-1 items-start justify-center overflow-auto p-3">
                {shown?.screenshot_key ?
                    <ObjectImage
                        key={shown.screenshot_key}
                        objectKey={shown.screenshot_key}
                        alt={`What the agent saw after “${shown.title}”`}
                        unavailableText="Screenshot not stored"
                        className="h-auto max-h-full w-auto max-w-full rounded-md border object-contain shadow-sm"
                    />
                :   <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                        {recording ?
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                Waiting for the first screenshot…
                            </>
                        :   "No screenshots were taken."}
                    </div>
                }
            </div>

            {steps.length ?
                <ol
                    ref={listRef}
                    className="max-h-40 shrink-0 overflow-y-auto border-t py-1 text-sm">
                    {steps.map((step, i) => {
                        const active = shown?.id === step.id;
                        return (
                            <li key={step.id}>
                                <button
                                    type="button"
                                    disabled={!step.screenshot_key}
                                    onClick={() =>
                                        setPicked(
                                            (
                                                step.id ===
                                                    shots[shots.length - 1]?.id
                                            ) ?
                                                null
                                            :   step.id,
                                        )
                                    }
                                    className={cn(
                                        "flex w-full items-baseline gap-2 px-3 py-1 text-left",
                                        active ? "bg-muted" : (
                                            step.screenshot_key &&
                                                "hover:bg-muted/60"
                                        ),
                                    )}>
                                    <span className="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums">
                                        {i + 1}
                                    </span>
                                    <span
                                        className={cn(
                                            "min-w-0 truncate",
                                            step.status === "failed" &&
                                                "text-destructive",
                                        )}>
                                        {step.title || step.kind}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ol>
            :   null}
        </div>
    );
}
