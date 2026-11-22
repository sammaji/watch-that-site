import type { MacroStep, RecordMacroRequest } from "@watchthatsite/types";
import type { Logger } from "pino";
import { maxConcurrentRecordings, recordLimits } from "../config/constants.js";
import type { BlockerProvider } from "../lib/blocking.js";
import type { BrowserPool } from "../lib/browser-pool.js";
import { createPlayer, playMacro } from "../macro/player.js";
import { SecretSession } from "../macro/secrets.js";
import { openMonitorPage } from "../macro/session.js";
import type { MonitorRow, ResolvedConnection } from "../store/store.js";
import { Trace } from "../store/trace.js";
import { BrowserSession } from "./browser.js";
import {
    adapterOf,
    AgentJobError,
    stopMessage,
    traceTools,
    type AgentDeps,
} from "./job.js";
import { runAgent, type AgentTool } from "./loop.js";
import { clip, PageData } from "./page-data.js";
import { ProviderError } from "./providers/errors.js";
import { SiteScope } from "./site-scope.js";
import { text } from "./types.js";

/**
 * The record job: the Agent drives a fresh browser towards a goal the owner
 * wrote, and every action it takes becomes a Macro step. When it says it is
 * done, the steps are replayed once in another fresh browser, without a
 * model, to prove they work on their own.
 */

export interface RecorderDeps extends AgentDeps {
    pool: BrowserPool;
    blockers: BlockerProvider;
}

type RecordAnswer =
    { kind: "done"; summary: string } | { kind: "fail"; reason: string };

type Outcome = { status: "draft" | "failed"; steps: MacroStep[]; note: string };

function systemPrompt(pageData: PageData, maxActions: number): string {
    return `You work inside WatchThatSite, a service that watches a web page for its owner. Some pages only show what the owner wants watched after a few actions: signing in, opening a tab, setting a filter. You are recording a Macro for such a page. You drive a real browser towards the owner's goal, and every action you take becomes a step that is replayed before each Capture, later, without you.

How to work
- Look at the page, act on one element by its ref, read the result. Each action returns the new list of elements; call snapshot when you need to see the page itself.
- Take only the actions the goal needs. Every action is replayed on every Run, so do not explore by clicking, and do not repeat an action that worked.
- Give each action an intent: why you take it, in plain words for the owner ("Open the Billing tab"). It becomes the step's description, and it is what a later repair reads if the page changes.
- If a cookie or consent banner is in the way, dismiss it.
- Do nothing the goal does not ask for. Never submit a form that buys, sends, deletes or changes account settings unless the goal says so in as many words.
- Stay on the Monitor's own site. You cannot open other sites; if the site itself sends you to another host to sign in, you may continue there.

Credentials
The owner stores credentials as named secrets. You are told the names, never the values. To type one, give fill the placeholder exactly, such as {{secret:password}}, and the value is filled in for you. If the goal needs a credential and no secret fits, call fail and name what is missing ("add a secret for the account password").

Finishing
When the page shows what the goal asks for, call done with one sentence on what the Macro does. If the goal cannot be reached (the credentials are refused, a CAPTCHA or a code sent to the owner's phone is in the way, a secret is missing, the thing is not on the site), call fail with a reason the owner can act on. You have ${maxActions} actions.

${pageData.rule}`;
}

/** A counting gate: at most `size` holders at once, the rest wait in line. */
class Gate {
    private free: number;
    private readonly waiting: (() => void)[] = [];

    constructor(size: number) {
        this.free = size;
    }

    async enter(): Promise<void> {
        if (this.free > 0) {
            this.free--;
            return;
        }
        await new Promise<void>(resolve => this.waiting.push(resolve));
    }

    leave(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.free++;
    }
}

export class Recorder {
    private readonly gate = new Gate(maxConcurrentRecordings);
    private readonly inFlight = new Set<Promise<void>>();
    private readonly stop = new AbortController();

    constructor(private readonly deps: RecorderDeps) {}

    /**
     * Inserts the `recording` Macro version and starts the work in the
     * background. Throws AgentJobError (`not_found`, `bad_request`) or
     * NoConnectionError before anything is inserted.
     */
    async start(req: RecordMacroRequest): Promise<string> {
        const { store } = this.deps;
        const monitor = await store.getMonitor(req.monitor_id);
        if (!monitor)
            throw new AgentJobError("not_found", "There is no such Monitor");
        const goal = req.goal.trim();
        if (goal === "")
            throw new AgentJobError("bad_request", "goal must not be empty");
        // Checked up front, so the owner hears "add a connection" at once
        // rather than from a recording that failed a moment later.
        const connection = await store.resolveConnection({
            userId: monitor.userId,
            connectionId: monitor.connectionId,
            model: monitor.model,
        });

        const macroId = await store.insertRecording(monitor, goal);
        const log = this.deps.logger.child({ monitorId: monitor.id, macroId });
        const work = this.run(monitor, macroId, goal, connection, log).finally(
            () => {
                this.inFlight.delete(work);
            },
        );
        this.inFlight.add(work);
        return macroId;
    }

    /** Stops recordings in flight and waits for them to be marked failed. */
    async close(): Promise<void> {
        this.stop.abort();
        await Promise.allSettled([...this.inFlight]);
    }

    private async run(
        monitor: MonitorRow,
        macroId: string,
        goal: string,
        connection: ResolvedConnection,
        log: Logger,
    ): Promise<void> {
        let outcome: Outcome;
        await this.gate.enter();
        try {
            outcome = await this.record(
                monitor,
                macroId,
                goal,
                connection,
                log,
            );
        } catch (err) {
            log.warn({ err }, "[record] recording failed");
            outcome = {
                status: "failed",
                steps: [],
                note:
                    err instanceof ProviderError ?
                        `The model call failed: ${err.message}`
                    : this.stop.signal.aborted ?
                        "Recording was interrupted because the worker restarted. Start it again."
                    :   `Recording stopped on an error: ${err instanceof Error ? (err.message.split("\n")[0] ?? "") : "unknown error"}`,
            };
        } finally {
            this.gate.leave();
        }
        try {
            await this.deps.store.finishRecording(macroId, {
                ...outcome,
                note: outcome.note.slice(0, 1000),
            });
            log.info(
                { status: outcome.status, steps: outcome.steps.length },
                "[record] finished",
            );
        } catch (err) {
            log.error(
                { err },
                "[record] could not save the recording's outcome",
            );
        }
    }

    private async record(
        monitor: MonitorRow,
        macroId: string,
        goal: string,
        connection: ResolvedConnection,
        log: Logger,
    ): Promise<Outcome> {
        const { store } = this.deps;
        const trace = await Trace.open(
            store,
            {
                runId: null,
                macroId,
                monitorId: monitor.id,
                userId: monitor.userId,
            },
            log,
        );
        const secretNames = await store.secretNames(monitor.id);
        const readSecret = (name: string) => store.readSecret(monitor.id, name);

        let steps: MacroStep[] = [];
        let answer: RecordAnswer | null = null;
        let stopped = "";

        const live = await openMonitorPage(
            { ...this.deps, logger: log },
            monitor,
        );
        try {
            const pageData = new PageData();
            const scope = new SiteScope(monitor.url);
            // A URL that itself redirects to a sign-in host is the site's doing.
            scope.landedOn(live.page.url());
            const session = new BrowserSession({
                page: live.page,
                tracker: live.tracker,
                secrets: new SecretSession(readSecret),
                secretNames,
                scope,
                pageData,
                trace,
                monitorId: monitor.id,
                objectStore: this.deps.objectStore,
                logger: log,
                maxActions: recordLimits.maxActions,
            });

            const tools: AgentTool<RecordAnswer>[] = [
                ...session.tools<RecordAnswer>(),
                {
                    def: {
                        name: "done",
                        description:
                            "The page shows what the goal asks for. Ends the recording.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                summary: {
                                    type: "string",
                                    description:
                                        "One sentence for the owner on what the Macro does.",
                                },
                            },
                            required: ["summary"],
                            additionalProperties: false,
                        },
                    },
                    async run(input) {
                        if (session.steps.length === 0) {
                            return {
                                content: [
                                    text(
                                        "No action has been taken, so there are no steps to record. If the page already shows what the goal asks for without any action, call fail and say that no Macro is needed.",
                                    ),
                                ],
                                isError: true,
                                title: null,
                            };
                        }
                        const summary = clip(String(input.summary), 300);
                        return {
                            content: [text("Recorded.")],
                            result: { kind: "done", summary },
                            title: `Finished: ${summary}`,
                        };
                    },
                },
                {
                    def: {
                        name: "fail",
                        description:
                            "The goal cannot be reached. Ends the recording with your reason.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                reason: {
                                    type: "string",
                                    description:
                                        "Why, in words the owner can act on.",
                                },
                            },
                            required: ["reason"],
                            additionalProperties: false,
                        },
                    },
                    async run(input) {
                        const reason = clip(String(input.reason), 400);
                        return {
                            content: [text("Recorded.")],
                            result: { kind: "fail", reason },
                            title: `Stopped: ${reason}`,
                            failed: true,
                        };
                    },
                },
            ];

            const first = [
                text(
                    [
                        `Monitor: ${monitor.name}`,
                        `URL: ${monitor.url}`,
                        "",
                        `The owner's goal:\n"""\n${goal}\n"""`,
                        "",
                        secretNames.length > 0 ?
                            `This Monitor's secrets: ${secretNames.map(n => `{{secret:${n}}}`).join(", ")}`
                        :   "This Monitor has no secrets.",
                        "",
                        "The browser has opened the URL. The page as it is now:",
                    ].join("\n"),
                ),
                ...(await session.snapshot()),
            ];

            // The same array the session appends to, so whatever was recorded
            // survives a model call that fails half way.
            steps = session.steps;
            let run;
            try {
                run = await runAgent<RecordAnswer>({
                    adapter: adapterOf(this.deps, connection),
                    system: systemPrompt(pageData, recordLimits.maxActions),
                    tools,
                    first,
                    limits: recordLimits,
                    finishHint:
                        "call done when the goal is reached, or fail when it cannot be",
                    onTool: traceTools(trace, "record"),
                    signal: this.stop.signal,
                });
            } catch (err) {
                if (!(err instanceof ProviderError)) throw err;
                return {
                    status: "failed",
                    steps,
                    note: `The model call failed: ${err.message}`,
                };
            }
            answer = run.result;
            if (!answer) stopped = stopMessage(run.stopped, run.steps);
        } finally {
            await live.close();
        }

        if (this.stop.signal.aborted) {
            return {
                status: "failed",
                steps,
                note: "Recording was interrupted because the worker restarted. Start it again.",
            };
        }
        if (!answer) {
            return {
                status: "failed",
                steps,
                note: `${stopped}. ${steps.length} step${steps.length === 1 ? " was" : "s were"} recorded before it stopped.`,
            };
        }
        if (answer.kind === "fail") {
            return { status: "failed", steps, note: answer.reason };
        }

        // Prove the steps stand on their own: a new browser, no saved
        // session, no model.
        const started = Date.now();
        const fresh = await openMonitorPage(
            { ...this.deps, logger: log },
            monitor,
        );
        let replay;
        try {
            replay = await playMacro(
                createPlayer(fresh.page, readSecret, {
                    tracker: fresh.tracker,
                    signal: this.stop.signal,
                }),
                steps,
            );
        } finally {
            await fresh.close();
        }
        await trace.write({
            phase: "record",
            kind: "verify",
            title:
                replay.ok ?
                    "Replayed the recorded steps in a fresh browser"
                :   "The recorded steps did not replay in a fresh browser",
            status: replay.ok ? "ok" : "failed",
            detail:
                replay.ok ?
                    { steps: steps.length }
                :   { failed_step: replay.failedStep, error: replay.error },
            screenshotKey: null,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - started,
        });
        if (!replay.ok) {
            return {
                status: "failed",
                steps,
                note: `The steps were recorded but did not replay on their own. ${replay.error}`,
            };
        }
        return { status: "draft", steps, note: answer.summary };
    }
}
