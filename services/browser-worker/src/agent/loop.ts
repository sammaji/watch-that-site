import { ProviderError } from "./providers/errors.js";
import {
    text,
    type AgentMessage,
    type ContentPart,
    type JsonSchema,
    type ProviderAdapter,
    type ToolDef,
    type ToolResult,
    type Usage,
} from "./types.js";

/**
 * The agent loop: one model turn after another, running the tools the model
 * calls, until a terminal tool accepts its input or a limit is reached.
 *
 * The loop is the same for every job (compare, plan, record, repair); a job
 * is a system prompt, a first message, and a set of tools.
 */

/** What a tool hands back to the model, and to the trace. */
export interface ToolOutcome<R> {
    content: ContentPart[];
    isError?: boolean;
    /**
     * Set by a terminal tool that accepted its input: the job's answer. The
     * loop stops. A terminal tool that rejects its input returns an error
     * instead, and the model tries again.
     */
    result?: R;
    /** The tool worked, but what it reports is a failure (the Agent gave up): shown as failed in the trace. */
    failed?: boolean;
    /** One line a person can read, for the trace. Null: leave it out of the trace. */
    title?: string | null;
    /** Extra facts for the trace row. Must not hold secrets or page-sized text. */
    detail?: Record<string, unknown>;
    screenshotKey?: string | null;
    /** The trace row's `seq`, when the tool reserved one (to name a screenshot after it). */
    traceSeq?: number;
}

export interface AgentTool<R> {
    def: ToolDef;
    run(
        input: Record<string, unknown>,
        signal: AbortSignal,
    ): Promise<ToolOutcome<R>>;
}

/** One tool use, as the trace sees it. */
export interface ToolEvent<R> {
    name: string;
    input: Record<string, unknown>;
    outcome: ToolOutcome<R>;
    durationMs: number;
    /**
     * Tokens of the model turn that asked for this tool. A turn's tokens are
     * counted once, on its first tool; turns without a tool roll into the
     * next event, so the events of a job add up to its total.
     */
    usage: Usage;
}

export type StopCause = "done" | "step_limit" | "time_limit" | "no_tool_call";

export interface AgentRun<R> {
    /** The terminal tool's answer, or null when the loop stopped without one. */
    result: R | null;
    stopped: StopCause;
    usage: Usage;
    /** Model turns taken. */
    steps: number;
    /** The model as the provider reported it, else the one asked for. */
    model: string;
}

export interface RunAgentOptions<R> {
    adapter: ProviderAdapter;
    system: string;
    tools: AgentTool<R>[];
    first: ContentPart[];
    limits: { maxSteps: number; wallClockMs: number };
    /** What to tell the model when it must wrap up: "call `report`". */
    finishHint: string;
    signal?: AbortSignal;
    onTool?: (event: ToolEvent<R>) => Promise<void>;
}

/** Checks `value` against the subset of JSON Schema the tools use. Null when it fits. */
export function validateInput(
    schema: JsonSchema,
    value: unknown,
    path = "input",
): string | null {
    if (schema.enum && !schema.enum.includes(value as string | number)) {
        return `${path} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`;
    }
    switch (schema.type) {
        case "object": {
            if (
                typeof value !== "object" ||
                value === null ||
                Array.isArray(value)
            ) {
                return `${path} must be an object`;
            }
            const record = value as Record<string, unknown>;
            for (const key of schema.required ?? []) {
                if (record[key] === undefined || record[key] === null) {
                    return `${path}.${key} is required`;
                }
            }
            for (const [key, child] of Object.entries(
                schema.properties ?? {},
            )) {
                if (record[key] === undefined || record[key] === null) continue;
                const problem = validateInput(
                    child,
                    record[key],
                    `${path}.${key}`,
                );
                if (problem) return problem;
            }
            return null;
        }
        case "array": {
            if (!Array.isArray(value)) return `${path} must be an array`;
            if (
                schema.minItems !== undefined &&
                value.length < schema.minItems
            ) {
                return `${path} needs at least ${schema.minItems} item(s)`;
            }
            if (
                schema.maxItems !== undefined &&
                value.length > schema.maxItems
            ) {
                return `${path} may hold at most ${schema.maxItems} item(s)`;
            }
            if (schema.items) {
                for (let i = 0; i < value.length; i++) {
                    const problem = validateInput(
                        schema.items,
                        value[i],
                        `${path}[${i}]`,
                    );
                    if (problem) return problem;
                }
            }
            return null;
        }
        case "string":
            return typeof value === "string" ? null : (
                    `${path} must be a string`
                );
        case "boolean":
            return typeof value === "boolean" ? null : (
                    `${path} must be true or false`
                );
        case "integer":
        case "number": {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return `${path} must be a number`;
            }
            if (schema.type === "integer" && !Number.isInteger(value)) {
                return `${path} must be a whole number`;
            }
            if (schema.minimum !== undefined && value < schema.minimum) {
                return `${path} must be at least ${schema.minimum}`;
            }
            if (schema.maximum !== undefined && value > schema.maximum) {
                return `${path} must be at most ${schema.maximum}`;
            }
            return null;
        }
        default:
            return null;
    }
}

const addUsage = (a: Usage, b: Usage): Usage => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
});

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

export async function runAgent<R>(
    opts: RunAgentOptions<R>,
): Promise<AgentRun<R>> {
    const { adapter, tools, limits } = opts;
    const byName = new Map(tools.map(tool => [tool.def.name, tool]));
    const messages: AgentMessage[] = [{ role: "user", content: opts.first }];

    // One signal for the whole job: the caller's, or the wall clock.
    const clock = new AbortController();
    const timer = setTimeout(() => clock.abort(), limits.wallClockMs);
    const onOuterAbort = () => clock.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    if (opts.signal?.aborted) clock.abort();

    let usage = noUsage();
    let pending = noUsage();
    let steps = 0;
    let model = adapter.model;
    let silentTurns = 0;

    const finish = (stopped: StopCause, result: R | null): AgentRun<R> => ({
        result,
        stopped,
        usage,
        steps,
        model,
    });

    try {
        while (steps < limits.maxSteps) {
            if (clock.signal.aborted) return finish("time_limit", null);

            let turn;
            try {
                turn = await adapter.complete(
                    {
                        system: opts.system,
                        tools: tools.map(t => t.def),
                        messages,
                    },
                    clock.signal,
                );
            } catch (err) {
                if (clock.signal.aborted) return finish("time_limit", null);
                throw err;
            }
            steps++;
            usage = addUsage(usage, turn.usage);
            pending = addUsage(pending, turn.usage);
            if (turn.model) model = turn.model;

            if (turn.stop === "refusal") {
                throw new ProviderError(
                    `The model declined to answer${turn.text ? `: ${turn.text.slice(0, 200)}` : ""}`,
                );
            }
            if (turn.stop === "max_tokens") {
                throw new ProviderError(
                    "The model ran out of output tokens before finishing its turn",
                );
            }

            messages.push({
                role: "assistant",
                text: turn.text,
                toolCalls: turn.toolCalls,
                raw: turn.raw,
            });

            if (turn.toolCalls.length === 0) {
                // The job ends through a tool, never through prose.
                if (++silentTurns >= 3) return finish("no_tool_call", null);
                messages.push({
                    role: "user",
                    content: [
                        text(
                            `That reply was text only, which nobody reads: only tool calls count. If the work is done, ${opts.finishHint} now. Otherwise call the next tool.`,
                        ),
                    ],
                });
                continue;
            }
            silentTurns = 0;

            const results: ToolResult[] = [];
            let answer: R | undefined;
            for (const call of turn.toolCalls) {
                // After the answer is in, the rest of the turn is moot, but
                // every call still needs a result for the transcript.
                if (answer !== undefined) {
                    results.push({
                        callId: call.id,
                        name: call.name,
                        content: [
                            text("Not run: the job was already finished."),
                        ],
                        isError: true,
                    });
                    continue;
                }
                const started = Date.now();
                const tool = byName.get(call.name);
                const input = (call.input ?? {}) as Record<string, unknown>;
                let outcome: ToolOutcome<R>;
                if (!tool) {
                    outcome = {
                        content: [
                            text(
                                `There is no tool called "${call.name}". The tools are: ${[...byName.keys()].join(", ")}.`,
                            ),
                        ],
                        isError: true,
                        title: null,
                    };
                } else {
                    const problem =
                        call.inputError ??
                        validateInput(tool.def.inputSchema, input);
                    if (problem) {
                        outcome = {
                            content: [
                                text(
                                    `Invalid arguments: ${problem}. Try again.`,
                                ),
                            ],
                            isError: true,
                            title: null,
                        };
                    } else {
                        try {
                            outcome = await tool.run(input, clock.signal);
                        } catch (err) {
                            if (err instanceof ProviderError) throw err;
                            outcome = {
                                content: [
                                    text(
                                        `The tool failed: ${err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err)}`,
                                    ),
                                ],
                                isError: true,
                            };
                        }
                    }
                }
                results.push({
                    callId: call.id,
                    name: call.name,
                    content: outcome.content,
                    isError: outcome.isError ?? false,
                });
                if (opts.onTool) {
                    await opts.onTool({
                        name: call.name,
                        input,
                        outcome,
                        durationMs: Date.now() - started,
                        usage: pending,
                    });
                    pending = noUsage();
                }
                if (outcome.result !== undefined && !outcome.isError) {
                    answer = outcome.result;
                }
            }

            if (answer !== undefined) return finish("done", answer);

            if (steps === limits.maxSteps - 1) {
                results[results.length - 1]!.content.push(
                    text(
                        `You have one turn left. Now ${opts.finishHint} with the best answer you have.`,
                    ),
                );
            }
            messages.push({ role: "tool", results });
        }
        return finish(clock.signal.aborted ? "time_limit" : "step_limit", null);
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onOuterAbort);
    }
}
