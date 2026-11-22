import { isRunning, type MonitorRun } from "@/hooks/use-monitor-runs";
import { VERDICT_LABEL, invalidReasonCopy } from "./format";

/** What the Run concluded, or why it failed, in one line. */
export function runSummary(
    run: Pick<
        MonitorRun,
        "status" | "summary" | "error" | "invalid_reason" | "verdict"
    >,
): string {
    if (run.status === "failed") {
        if (run.error?.message) return run.error.message;
        if (run.invalid_reason) return invalidReasonCopy(run.invalid_reason);
        return "The Run failed.";
    }
    if (isRunning(run)) return "In progress…";
    if (run.summary) return run.summary;
    return run.verdict ? VERDICT_LABEL[run.verdict] : "";
}

/** "Planned the page: 5 sections" when the Run made a Watch Plan, else "". */
export function planNote(
    run: Pick<MonitorRun, "id" | "run_steps">,
    plan?: { run_id: string; sections: unknown[] } | null,
): string {
    if (!run.run_steps?.length) return "";
    if (run.run_steps.every(step => step.status === "failed")) {
        return "Could not plan the page";
    }
    if (plan && plan.run_id === run.id) {
        const n = plan.sections.length;
        return `Planned the page: ${n} section${n === 1 ? "" : "s"}`;
    }
    return "Planned the page";
}
