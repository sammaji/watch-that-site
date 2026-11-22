import {
    describeStep,
    MACRO_MAX_STEPS,
    stepScreenshotKey,
    type MacroResult,
    type MacroStep,
    type ScrapeJob,
} from "@watchthatsite/types";
import type { Logger } from "pino";
import type { Locator, Page } from "playwright-core";
import { maxRepairsPerRun } from "../config/constants.js";
import type { NetworkTracker } from "../lib/stabilize.js";
import type { MacroRow, MonitorRow, Store } from "../store/store.js";
import { Trace } from "../store/trace.js";
import type { ObjectStore } from "../types.js";
import { createPlayer, failureMessage, playStep } from "./player.js";
import { uploadStepScreenshot } from "./screenshot.js";
import type { SecretSession } from "./secrets.js";

/** What the Agent is asked when a step of a Run's Macro stops working. */
export interface RepairRequest {
    page: Page;
    tracker: NetworkTracker;
    /** The replay's secrets, so what the model sees is scrubbed of values already typed. */
    secrets: SecretSession;
    sensitive: Locator[];
    monitor: MonitorRow;
    macro: MacroRow;
    /** The steps as they stand, earlier repairs of this Run included. */
    steps: MacroStep[];
    /** Index into `steps` of the one that failed. */
    index: number;
    /** Why it failed, as the player reported it. */
    error: string;
    trace: Trace;
    signal?: AbortSignal;
}

export interface RepairResult {
    ok: boolean;
    /** The steps that replace the failed one. */
    steps: MacroStep[];
    /** What changed on the page, in a few words for the owner. */
    note: string;
    /** Why the step could not be repaired; "" when it was. */
    error: string;
    inputTokens: number;
    outputTokens: number;
}

export interface Repairer {
    repair(request: RepairRequest): Promise<RepairResult>;
}

export interface MacroRun {
    result: MacroResult;
    /** Set when the Macro failed: a message a person can act on. */
    error: string | null;
}

export interface MacroRunner {
    /** Replays the job's Macro on `page`, which already shows the Monitor's URL. */
    run(args: {
        page: Page;
        tracker: NetworkTracker;
        job: ScrapeJob;
        log: Logger;
        signal?: AbortSignal;
    }): Promise<MacroRun>;
}

/**
 * Replays a Run's Macro step by step, writing the trace as it goes. When a
 * step that is not optional fails, the Agent is asked to repair it (at most
 * `maxRepairsPerRun` times); the one action it takes replaces the step and
 * replay goes on. A Macro that was repaired and then completed is saved as a new
 * active version.
 */
export function createMacroRunner(deps: {
    store: Store;
    objectStore: ObjectStore | null;
    /** Null: no repairs; a failing step fails the Macro. */
    repairer: Repairer | null;
}): MacroRunner {
    const { store } = deps;
    return {
        async run({ page, tracker, job, log, signal }) {
            const macroId = job.macro_id!;
            const result: MacroResult = {
                macro_id: macroId,
                status: "ok",
                failed_step: null,
                repaired_macro_id: null,
                input_tokens: 0,
                output_tokens: 0,
            };
            const failed = (index: number | null, error: string): MacroRun => ({
                result: { ...result, status: "failed", failed_step: index },
                error,
            });

            const [monitor, macro] = await Promise.all([
                store.getMonitor(job.monitor_id),
                store.getMacro(macroId),
            ]);
            if (!monitor || !macro || macro.monitorId !== job.monitor_id) {
                return failed(
                    null,
                    "The pre-scraping this Run was started with no longer exists. Run the Monitor again.",
                );
            }
            if (macro.steps.length > MACRO_MAX_STEPS) {
                return failed(
                    null,
                    `Pre-scraping has ${macro.steps.length} steps; at most ${MACRO_MAX_STEPS} are allowed.`,
                );
            }

            // A redelivered job replays from the start: drop what the first
            // attempt wrote, so the trace shows one replay.
            await store
                .clearRunSteps(job.run_id, ["macro", "repair"])
                .catch(err =>
                    log.warn({ err }, "[macro] could not clear earlier steps"),
                );
            const trace = await Trace.open(
                store,
                {
                    runId: job.run_id,
                    macroId: null,
                    monitorId: monitor.id,
                    userId: monitor.userId,
                },
                log,
            );
            const player = createPlayer(
                page,
                name => store.readSecret(monitor.id, name),
                { tracker, ...(signal ? { signal } : {}) },
            );

            const steps = [...macro.steps];
            // Where each current step sits in the stored Macro, so messages
            // and `failed_step` use the numbers the owner sees.
            const origin = steps.map((_, i) => i);
            const notes: string[] = [];
            let repairs = 0;

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i]!;
                const number = origin[i]!;
                const seq = trace.reserve();
                const played = await playStep(player, step, number);
                const shot = () =>
                    uploadStepScreenshot(
                        page,
                        deps.objectStore,
                        stepScreenshotKey(monitor.id, job.run_id, seq),
                        player.sensitive,
                        log,
                    );
                const row = {
                    seq,
                    phase: "macro" as const,
                    kind: step.type,
                    title: describeStep(step),
                    inputTokens: 0,
                    outputTokens: 0,
                };

                if (played.status !== "failed") {
                    await trace.write({
                        ...row,
                        status: played.status,
                        detail: {
                            step: number,
                            ...(played.selector ?
                                { selector: played.selector }
                            :   {}),
                            ...(played.error ? { note: played.error } : {}),
                        },
                        screenshotKey: await shot(),
                        durationMs: played.durationMs,
                    });
                    continue;
                }

                const message = failureMessage(number, step, played.error);
                const giveUp = async (why: string): Promise<MacroRun> => {
                    await trace.write({
                        ...row,
                        status: "failed",
                        detail: {
                            step: number,
                            error: played.error,
                            ...(why ? { repair: why } : {}),
                        },
                        screenshotKey: await shot(),
                        durationMs: played.durationMs,
                    });
                    return failed(number, why ? `${message}. ${why}` : message);
                };

                if (deps.repairer === null || signal?.aborted)
                    return giveUp("");
                if (repairs >= maxRepairsPerRun) {
                    return giveUp(
                        `It was not repaired: ${maxRepairsPerRun} steps of pre-scraping were already repaired in this Run, so it needs recording again.`,
                    );
                }
                repairs++;
                const repaired = await deps.repairer.repair({
                    page,
                    tracker,
                    secrets: player.secrets,
                    sensitive: player.sensitive,
                    monitor,
                    macro,
                    steps,
                    index: i,
                    error: played.error,
                    trace,
                    ...(signal ? { signal } : {}),
                });
                result.input_tokens += repaired.inputTokens;
                result.output_tokens += repaired.outputTokens;
                if (!repaired.ok || repaired.steps.length === 0) {
                    return giveUp(
                        repaired.error || "It could not be repaired.",
                    );
                }

                steps.splice(i, 1, ...repaired.steps);
                origin.splice(i, 1, ...repaired.steps.map(() => number));
                notes.push(
                    `Step ${number + 1} '${describeStep(step)}': ${repaired.note}`,
                );
                await trace.write({
                    ...row,
                    status: "repaired",
                    detail: {
                        step: number,
                        error: played.error,
                        repair: repaired.note,
                    },
                    screenshotKey: await shot(),
                    durationMs: played.durationMs,
                });
                i += repaired.steps.length - 1;
            }

            if (repairs === 0) return { result, error: null };

            // Replay completed with repaired steps: later Runs replay them.
            try {
                const newId = await store.insertRepair(
                    macro,
                    monitor,
                    steps,
                    notes.join("; ").slice(0, 1000),
                );
                if (newId !== null) {
                    result.status = "repaired";
                    result.repaired_macro_id = newId;
                } else {
                    log.info(
                        "[macro] repaired a version that is no longer active; not saved",
                    );
                }
            } catch (err) {
                // The page is in the right state all the same; the next Run
                // repairs again.
                log.error({ err }, "[macro] could not save the repaired Macro");
            }
            return { result, error: null };
        },
    };
}
