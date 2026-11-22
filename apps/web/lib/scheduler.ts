import "server-only";

import type {
    ChangeRecord,
    ChangeStatus,
    MacroOutcome,
    RunVerdict,
    WatchPlan,
} from "@watchthatsite/types";

/**
 * Server-side client for the scheduler's internal admin API
 * (services/scheduler/internal/admin). Every call carries the
 * SCHEDULER_ADMIN_TOKEN bearer, so it must only ever run on the server, after
 * the caller's ownership of the Monitor has been checked.
 */

/** `confirm` re-checks a Change that is waiting to be confirmed. */
export type RunTrigger = "manual" | "confirm";

export interface RunStatus {
    run_id: string;
    monitor_id: string;
    status: "pending" | "processing" | "succeeded" | "failed";
    trigger: string;
    verdict: RunVerdict | null;
    /** A few words on what the Run concluded. */
    summary: string | null;
    invalid_reason: string | null;
    error: { code: string; message: string } | null;
    /** The Macro version replayed, and how it went; null without a Macro. */
    macro_id: string | null;
    macro_status: MacroOutcome | null;
    input_tokens: number;
    output_tokens: number;
    change_id: string | null;
    change_status: ChangeStatus | null;
}

export class SchedulerError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "SchedulerError";
    }
}

function config(): { url: string; token: string } {
    const url = process.env.SCHEDULER_ADMIN_URL ?? "http://localhost:5210";
    const token = process.env.SCHEDULER_ADMIN_TOKEN;
    if (!token) {
        throw new SchedulerError(
            500,
            "SCHEDULER_ADMIN_TOKEN is not configured.",
        );
    }
    return { url: url.replace(/\/+$/, ""), token };
}

async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
): Promise<T> {
    const { url, token } = config();
    let response: Response;
    try {
        response = await fetch(`${url}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new SchedulerError(
            502,
            "The scheduler is not reachable right now. Try again in a minute.",
        );
    }
    const text = await response.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    if (!response.ok) {
        const message =
            (json as { error?: { message?: string } } | null)?.error?.message ??
            `The scheduler responded ${response.status}.`;
        throw new SchedulerError(response.status, message);
    }
    return json as T;
}

export const scheduler = {
    runNow: (monitorId: string, trigger: RunTrigger = "manual") =>
        call<{ run_id: string }>(
            "POST",
            `/internal/monitors/${monitorId}/runs`,
            { trigger },
        ),
    getRun: (runId: string) =>
        call<RunStatus>("GET", `/internal/runs/${runId}`),
    acceptBaseline: (monitorId: string, runId: string) =>
        call<{ ok: true }>("POST", `/internal/monitors/${monitorId}/baseline`, {
            run_id: runId,
        }),
    /**
     * Compares two Runs' Captures on demand. Nothing is stored and no model
     * is called: the record comes back with the diff and no agent answer.
     */
    compare: (fromRun: string, toRun: string) =>
        call<ChangeRecord>("POST", "/internal/compare", {
            from_run: fromRun,
            to_run: toRun,
        }),
    /**
     * Asks the Agent for a new Watch Plan from the Monitor's latest Capture
     * and returns the saved plan. A model call with a screenshot, so it gets
     * a longer timeout than the others.
     */
    plan: (monitorId: string) =>
        call<WatchPlan>(
            "POST",
            `/internal/monitors/${monitorId}/plan`,
            {},
            5 * 60_000,
        ),
};
