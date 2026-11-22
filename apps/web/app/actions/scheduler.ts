"use server";

import { scheduler, type RunStatus, type RunTrigger } from "@/lib/scheduler";
import type { ChangeRecord, WatchPlan } from "@watchthatsite/types";
import { OwnerError, guarded, isUuid, type ActionResult } from "./guard";

/**
 * Server actions that reach the scheduler's admin API. Each one checks that
 * the Monitor belongs to the caller (see ./guard) before forwarding anything.
 */

export async function runNowAction(
    monitorId: string,
    trigger: RunTrigger = "manual",
): Promise<ActionResult<{ run_id: string }>> {
    return guarded(monitorId, () => {
        if (trigger !== "manual" && trigger !== "confirm") {
            throw new OwnerError("Unknown kind of Run.");
        }
        return scheduler.runNow(monitorId, trigger);
    });
}

export async function getRunAction(
    monitorId: string,
    runId: string,
): Promise<ActionResult<RunStatus>> {
    return guarded(monitorId, async () => {
        if (!isUuid(runId)) throw new OwnerError("Run not found.");
        const run = await scheduler.getRun(runId);
        if (run.monitor_id !== monitorId)
            throw new OwnerError("Run not found.");
        return run;
    });
}

export async function acceptBaselineAction(
    monitorId: string,
    runId: string,
): Promise<ActionResult<{ ok: true }>> {
    return guarded(monitorId, () => {
        if (!isUuid(runId)) throw new OwnerError("Run not found.");
        return scheduler.acceptBaseline(monitorId, runId);
    });
}

export async function compareAction(
    monitorId: string,
    fromRun: string,
    toRun: string,
): Promise<ActionResult<ChangeRecord>> {
    return guarded(monitorId, async () => {
        if (!isUuid(fromRun) || !isUuid(toRun)) {
            throw new OwnerError("Runs not found.");
        }
        const record = await scheduler.compare(fromRun, toRun);
        if (record.monitor.id !== monitorId) {
            throw new OwnerError("Runs not found.");
        }
        return record;
    });
}

/** Asks the Agent to plan the page again from the latest Capture. */
export async function replanAction(
    monitorId: string,
): Promise<ActionResult<WatchPlan>> {
    return guarded(monitorId, () => scheduler.plan(monitorId));
}
