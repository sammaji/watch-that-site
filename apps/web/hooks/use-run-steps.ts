"use client";

import { useQuery } from "@tanstack/react-query";
import { usePostgrest } from "@watchthatsite/auth/postgrest";
import type { RunStep, RunStepPhase } from "@watchthatsite/types";

/**
 * `run_steps` rows through PostgREST: the Trace of a Run (each Macro step
 * replayed, each repair, what the agent looked at while planning and
 * comparing) or of a Macro recording.
 */
export const runStepKeys = {
    all: ["run_steps"] as const,
    run: (runId: string) => ["run_steps", "run", runId] as const,
    recording: (macroId: string) => ["run_steps", "macro", macroId] as const,
    replay: (macroId: string) => ["run_steps", "replay", macroId] as const,
    planning: (monitorId: string, since: string) =>
        ["run_steps", "plan", monitorId, since] as const,
};

const stepCols = [
    "id",
    "run_id",
    "macro_id",
    "monitor_id",
    "seq",
    "phase",
    "kind",
    "title",
    "status",
    "detail",
    "screenshot_key",
    "input_tokens",
    "output_tokens",
    "duration_ms",
    "created_at",
].join();

/** Every step of one Run, in order. `poll` refetches while the Run is going. */
export function useRunSteps(runId?: string | null, poll = false) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<RunStep[]>({
        queryKey: runStepKeys.run(runId ?? ""),
        queryFn: async () => {
            if (!pgrst || !runId) return [];
            const { data, error } = await pgrst
                .from("run_steps")
                .select(stepCols)
                .eq("run_id", runId)
                .order("seq", { ascending: true })
                .limit(500);
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as RunStep[];
        },
        enabled: !!pgrst && !!runId,
        refetchInterval: poll ? 2_000 : false,
    });

    return {
        steps: query.data ?? [],
        isLoading: isPgrstLoading || (!!runId && query.isLoading),
        error: query.error,
    };
}

/**
 * What the agent has done so far in a recording, in order. `poll` refetches
 * every 1.5 s while the recording is still going.
 */
export function useRecordingSteps(macroId?: string | null, poll = false) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<RunStep[]>({
        queryKey: runStepKeys.recording(macroId ?? ""),
        queryFn: async () => {
            if (!pgrst || !macroId) return [];
            const { data, error } = await pgrst
                .from("run_steps")
                .select(stepCols)
                .eq("macro_id", macroId)
                .order("seq", { ascending: true })
                .limit(500);
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as RunStep[];
        },
        enabled: !!pgrst && !!macroId,
        refetchInterval: poll ? 1_500 : false,
    });

    return {
        steps: query.data ?? [],
        isLoading: isPgrstLoading || (!!macroId && query.isLoading),
        error: query.error,
    };
}

export type LastReplay = {
    runId: string;
    at: string;
    /** The Run's steps of phase `macro` and `repair`, in order. */
    steps: RunStep[];
};

/**
 * The latest Run that replayed Macro version `macroId`, with its Macro steps,
 * so the step list can show the screenshot each step last produced.
 */
export function useLastReplay(macroId?: string | null) {
    const { data: pgrst } = usePostgrest();

    const query = useQuery<LastReplay | null>({
        queryKey: runStepKeys.replay(macroId ?? ""),
        queryFn: async () => {
            if (!pgrst || !macroId) return null;
            const runs = await pgrst
                .from("monitor_runs")
                .select("id,created_at")
                .eq("macro_id", macroId)
                .not("macro_status", "is", null)
                .order("created_at", { ascending: false })
                .limit(1);
            if (runs.error) throw new Error(runs.error.message);
            const run = (
                runs.data as unknown as { id: string; created_at: string }[]
            )?.[0];
            if (!run) return null;
            const { data, error } = await pgrst
                .from("run_steps")
                .select(stepCols)
                .eq("run_id", run.id)
                .in("phase", ["macro", "repair"] satisfies RunStepPhase[])
                .order("seq", { ascending: true });
            if (error) throw new Error(error.message);
            return {
                runId: run.id,
                at: run.created_at,
                steps: (data ?? []) as unknown as RunStep[],
            };
        },
        enabled: !!pgrst && !!macroId,
    });

    return query.data ?? null;
}

/**
 * The agent's planning steps for a Monitor written since `since` (an ISO
 * time), polled while a re-plan is in flight.
 */
export function usePlanningSteps(
    monitorId: string | undefined,
    since: string | null,
) {
    const { data: pgrst } = usePostgrest();

    const query = useQuery<RunStep[]>({
        queryKey: runStepKeys.planning(monitorId ?? "", since ?? ""),
        queryFn: async () => {
            if (!pgrst || !monitorId || !since) return [];
            const { data, error } = await pgrst
                .from("run_steps")
                .select(stepCols)
                .eq("monitor_id", monitorId)
                .eq("phase", "plan")
                .gte("created_at", since)
                .order("created_at", { ascending: true })
                .order("seq", { ascending: true })
                .limit(100);
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as RunStep[];
        },
        enabled: !!pgrst && !!monitorId && !!since,
        refetchInterval: since ? 1_500 : false,
    });

    return query.data ?? [];
}
