import type { RunStepPhase } from "@watchthatsite/types";
import type { Logger } from "pino";
import type { ResolvedConnection, Store } from "../store/store.js";
import type { Trace } from "../store/trace.js";
import type { ObjectStore } from "../types.js";
import type { StopCause, ToolEvent } from "./loop.js";
import { adapterFor } from "./providers/index.js";
import type { ProviderAdapter, Usage } from "./types.js";

/** What every agent job needs from the outside world. */
export interface AgentDeps {
    store: Store;
    objectStore: ObjectStore | null;
    logger: Logger;
    /** Builds the provider adapter; tests replace it. */
    adapters?: (connection: ResolvedConnection) => ProviderAdapter;
}

export function adapterOf(
    deps: AgentDeps,
    connection: ResolvedConnection,
): ProviderAdapter {
    return (deps.adapters ?? adapterFor)(connection);
}

/**
 * A job that ended without an answer, with the AgentError code the HTTP API
 * reports for it.
 */
export class AgentJobError extends Error {
    constructor(
        readonly code:
            "provider_error" | "bad_request" | "not_found" | "internal_error",
        message: string,
    ) {
        super(message);
        this.name = "AgentJobError";
    }
}

/** Why the loop stopped without an answer, in words. */
export function stopMessage(stopped: StopCause, steps: number): string {
    switch (stopped) {
        case "time_limit":
            return "The model did not finish within the time limit";
        case "no_tool_call":
            return "The model answered in prose instead of using its tools";
        default:
            return `The model did not give an answer within ${steps} turns`;
    }
}

/**
 * The loop's `onTool` hook that writes one run_steps row per tool use. A tool
 * use with a null title (a malformed call the model then retried) writes no
 * row; its tokens move to the next row, so the rows still add up.
 */
export function traceTools<R>(
    trace: Trace,
    phase: RunStepPhase,
): (event: ToolEvent<R>) => Promise<void> {
    let carried: Usage = { inputTokens: 0, outputTokens: 0 };
    return async event => {
        const usage = {
            inputTokens: carried.inputTokens + event.usage.inputTokens,
            outputTokens: carried.outputTokens + event.usage.outputTokens,
        };
        if (event.outcome.title === null) {
            carried = usage;
            return;
        }
        carried = { inputTokens: 0, outputTokens: 0 };
        await trace.write({
            ...(event.outcome.traceSeq !== undefined ?
                { seq: event.outcome.traceSeq }
            :   {}),
            phase,
            kind: event.name,
            title: event.outcome.title ?? event.name,
            status:
                event.outcome.isError || event.outcome.failed ? "failed" : "ok",
            detail: event.outcome.detail ?? {},
            screenshotKey: event.outcome.screenshotKey ?? null,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            durationMs: event.durationMs,
        });
    };
}
