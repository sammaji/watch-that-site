import { describeStep, type MacroStep } from "@watchthatsite/types";
import { repairLimits } from "../config/constants.js";
import type { Repairer, RepairRequest, RepairResult } from "../macro/run.js";
import { NoConnectionError } from "../store/store.js";
import { BrowserSession } from "./browser.js";
import { adapterOf, stopMessage, traceTools, type AgentDeps } from "./job.js";
import { runAgent, type AgentTool } from "./loop.js";
import { clip, PageData } from "./page-data.js";
import { ProviderError } from "./providers/errors.js";
import { SiteScope } from "./site-scope.js";
import { text } from "./types.js";

/**
 * The repair job: a step of a Run's Macro stopped working. The Agent gets
 * the browser as the replay left it and completes that one step; the action
 * it takes becomes the step's replacement.
 */

type RepairAnswer =
    { kind: "done"; note: string } | { kind: "fail"; reason: string };

function systemPrompt(pageData: PageData, maxActions: number): string {
    return `You work inside WatchThatSite, a service that watches a web page for its owner. Before each Capture it replays a Macro: a list of browser actions (sign in, open a tab, set a filter) that brings the page into the state the owner wants watched. Replay uses no model, only stored selectors.

One step of this Macro no longer works, usually because the page changed: a button was renamed or moved, a field got a new label, a dialog now appears first. You have the browser exactly where the step failed. Complete that one step: find the element the step meant and take its action.

- You have ${maxActions === 1 ? "one action" : `${maxActions} actions`}. It replaces the broken step, and replay then continues by itself with the steps after it, so do only what this step was for and leave the later steps alone. Look with snapshot rather than by clicking.
- If the step typed a value, type the same value. A credential stays a placeholder such as {{secret:password}}; it is filled in for you and you never see it.
- Give each action an intent in plain words; it becomes the step's description.
- When the step is complete, call done with a few words for the owner on what had changed: "the button is now called 'Plans & billing'".
- When it cannot be completed (what the step was for is gone from the site, sign-in is refused, a CAPTCHA or a code you cannot get is in the way), call fail and say why in words the owner can act on.

${pageData.rule}`;
}

function stepList(steps: MacroStep[], index: number, error: string): string {
    return steps
        .map((step, i) => {
            const mark = i === index ? ">" : " ";
            const state =
                i < index ? "done"
                : i === index ? `FAILED: ${error}`
                : "not reached yet";
            return `${mark} ${i + 1}. ${describeStep(step)} (${step.type}; ${state})`;
        })
        .join("\n");
}

export function createRepairer(deps: AgentDeps): Repairer {
    return {
        async repair(req: RepairRequest): Promise<RepairResult> {
            const none = (
                error: string,
                usage = { inputTokens: 0, outputTokens: 0 },
            ): RepairResult => ({
                ok: false,
                steps: [],
                note: "",
                error,
                ...usage,
            });
            const step = req.steps[req.index]!;

            let connection;
            try {
                connection = await deps.store.resolveConnection({
                    userId: req.monitor.userId,
                    connectionId: req.monitor.connectionId,
                    model: req.monitor.model,
                });
            } catch (err) {
                if (err instanceof NoConnectionError) {
                    return none(
                        "It could not be repaired because the Monitor has no usable model connection.",
                    );
                }
                throw err;
            }

            const pageData = new PageData();
            const scope = new SiteScope(req.monitor.url);
            // Wherever the Macro has taken the browser so far is fair ground.
            scope.landedOn(req.page.url());
            const session = new BrowserSession({
                page: req.page,
                tracker: req.tracker,
                secrets: req.secrets,
                secretNames: await deps.store.secretNames(req.monitor.id),
                scope,
                pageData,
                trace: req.trace,
                monitorId: req.monitor.id,
                objectStore: deps.objectStore,
                logger: deps.logger,
                maxActions: repairLimits.maxActions,
                sensitive: req.sensitive,
            });

            const number = req.index + 1;
            const tools: AgentTool<RepairAnswer>[] = [
                ...session.tools<RepairAnswer>(),
                {
                    def: {
                        name: "done",
                        description:
                            "The step is complete. Ends the repair; replay continues with the next step.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                what_changed: {
                                    type: "string",
                                    description:
                                        "A few words for the owner on what had changed on the page.",
                                },
                            },
                            required: ["what_changed"],
                            additionalProperties: false,
                        },
                    },
                    async run(input) {
                        if (session.steps.length === 0) {
                            return {
                                content: [
                                    text(
                                        "You have not taken an action yet, so there is nothing to replace the step with. Take the action that completes the step, or call fail.",
                                    ),
                                ],
                                isError: true,
                                title: null,
                            };
                        }
                        const note = clip(String(input.what_changed), 200);
                        return {
                            content: [text("Recorded.")],
                            result: { kind: "done", note },
                            title: `Repaired step ${number}: ${note}`,
                        };
                    },
                },
                {
                    def: {
                        name: "fail",
                        description:
                            "The step cannot be completed. Ends the repair; the Run fails with your reason.",
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
                        const reason = clip(String(input.reason), 300);
                        return {
                            content: [text("Recorded.")],
                            result: { kind: "fail", reason },
                            title: `Step ${number} could not be repaired: ${reason}`,
                            failed: true,
                        };
                    },
                },
            ];

            const facts = [
                `The Macro's goal, in the owner's words: "${clip(req.macro.goal || "(none given)", 400)}"`,
                "",
                "Its steps:",
                stepList(req.steps, req.index, req.error),
                "",
                `The failed step is a ${step.type} step.`,
            ];
            if ("value" in step)
                facts.push(`The value it types or chooses: "${step.value}"`);
            if ("key" in step) facts.push(`The key it presses: ${step.key}`);
            if ("text" in step && step.text)
                facts.push(`The text it waits for: "${step.text}"`);
            if ("selectors" in step && step.selectors?.length) {
                facts.push(
                    "The selectors it tried, most trusted first (they describe the element as it was when the Macro was recorded):",
                    pageData.wrap("selectors", step.selectors.join("\n")),
                );
            }
            facts.push("", "The page as it is now:");

            let run;
            try {
                run = await runAgent<RepairAnswer>({
                    adapter: adapterOf(deps, connection),
                    system: systemPrompt(pageData, repairLimits.maxActions),
                    tools,
                    first: [
                        text(req.secrets.scrub(facts.join("\n"))),
                        ...(await session.snapshot()),
                    ],
                    limits: repairLimits,
                    finishHint:
                        "call done when the step is complete, or fail when it cannot be",
                    onTool: traceTools(req.trace, "repair"),
                    ...(req.signal ? { signal: req.signal } : {}),
                });
            } catch (err) {
                if (err instanceof ProviderError) {
                    return none(
                        `It could not be repaired because the model call failed: ${err.message}`,
                    );
                }
                throw err;
            } finally {
                await session.cleanup();
            }

            const usage = run.usage;
            if (!run.result) {
                return none(
                    `It could not be repaired: ${stopMessage(run.stopped, run.steps).toLowerCase()}.`,
                    usage,
                );
            }
            if (run.result.kind === "fail") {
                return none(
                    `It could not be repaired: ${run.result.reason}`,
                    usage,
                );
            }
            // The action stands in for the step and keeps the wording the
            // owner knows it by.
            const steps = session.steps.map(taken =>
                step.intent.trim() !== "" ?
                    { ...taken, intent: step.intent }
                :   taken,
            );
            return {
                ok: true,
                steps,
                note: run.result.note,
                error: "",
                ...usage,
            };
        },
    };
}
