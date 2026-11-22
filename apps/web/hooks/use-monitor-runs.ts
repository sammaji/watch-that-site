"use client";

import { getRunAction, runNowAction } from "@/app/actions/scheduler";
import type { RunStatus } from "@/lib/scheduler";
import { defaultNull } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@watchthatsite/auth/client";
import { usePostgrest } from "@watchthatsite/auth/postgrest";
import type {
    AgentVerdict,
    ChangeStatus,
    MacroOutcome,
    RunVerdict,
} from "@watchthatsite/types";
import * as React from "react";
import { Entity, Operation } from "./keys";
import { type GenericQueryError } from "./types";

export type MonitorRunStatus =
    "pending" | "processing" | "succeeded" | "failed";

export type RunTrigger = "schedule" | "manual" | "confirm";

export type { RunStatus };

/** A `monitor_runs` row: the operational record of one Run. */
export type MonitorRun = {
    id: string;
    monitor_id: string;
    status: MonitorRunStatus;
    trigger: RunTrigger;
    /** Outcome of a succeeded Run; null while running or when it failed. */
    verdict: RunVerdict | null;
    /** A few words on what the Run concluded, quiet Runs included. */
    summary: string | null;
    error: { code?: string; message: string; occurred_at?: string } | null;
    /** Why the Capture was rejected (http_status, challenge, macro_failed...). */
    invalid_reason: string | null;
    /** The Macro version replayed and how it went; null without a Macro. */
    macro_id: string | null;
    macro_status: MacroOutcome | null;
    /** Model usage across the Run: Macro repair, planning and the comparison. */
    input_tokens: number;
    output_tokens: number;
    created_at: string;
    updated_at: string;
    monitor: { name: string; url: string } | null;
    /** The Change this Run raised, if any (at most one). */
    changes: Array<{
        id: string;
        status: ChangeStatus;
        agent: Partial<AgentVerdict> | null;
    }>;
    /** Steps of phase `plan`: present when the Run made a Watch Plan. */
    run_steps: Array<{ title: string; status: string }>;
};

const runBaseCols = [
    "id",
    "monitor_id",
    "status",
    "trigger",
    "verdict",
    "summary",
    "error",
    "invalid_reason",
    "macro_id",
    "macro_status",
    "input_tokens",
    "output_tokens",
    "created_at",
    "updated_at",
    // changes has two FKs to monitor_runs (run_id, from_run_id): pick run_id.
    "changes:changes!changes_run_id_fkey(id,status,agent)",
    // Filtered to phase `plan` by every query below.
    "run_steps(title,status)",
];

const runCols = [...runBaseCols, "monitor:monitors(name,url)"].join();

export type RunFilters = {
    status?: MonitorRunStatus | "all";
    verdict?: RunVerdict | "all";
    monitorId?: string | "all";
};

export function isRunning(run: Pick<MonitorRun, "status">): boolean {
    return run.status === "pending" || run.status === "processing";
}

export function useMonitorRuns({
    page = 1,
    pageSize = 50,
    filters = {},
}: { page?: number; pageSize?: number; filters?: RunFilters } = {}) {
    const {
        data: pgrst,
        error: pgrstInitError,
        isLoading: isPgrstLoading,
    } = usePostgrest();

    const { data: session, isPending: isSessionPending } =
        authClient.useSession();

    const userId = session?.user?.id;
    const { status = "all", verdict = "all", monitorId = "all" } = filters;

    const runsQuery = useQuery<{ data: MonitorRun[]; count: number }>({
        queryKey: [
            Entity.monitorRun,
            Operation.list,
            userId,
            page,
            pageSize,
            status,
            verdict,
            monitorId,
        ],
        queryFn: async () => {
            if (!pgrst || !userId) return { data: [], count: 0 };

            const offset = (page - 1) * pageSize;
            const query = pgrst
                .from("monitor_runs")
                .select(runCols, { count: "exact" })
                .eq("run_steps.phase", "plan")
                .order("created_at", { ascending: false })
                .range(offset, offset + pageSize - 1);

            query.eq("user_id", userId);
            if (status !== "all") query.eq("status", status);
            if (verdict !== "all") query.eq("verdict", verdict);
            if (monitorId !== "all") query.eq("monitor_id", monitorId);

            const { data, error, count } = await query;
            if (error) throw new Error(error.message);
            return {
                data: (data ?? []) as unknown as MonitorRun[],
                count: count ?? 0,
            };
        },
        enabled: !!pgrst && !!userId,
        placeholderData: previous => previous,
    });

    const error = React.useMemo<GenericQueryError | null>(() => {
        if (pgrstInitError) return { message: pgrstInitError.message };
        if (runsQuery.error !== null)
            return { message: runsQuery.error.message };
        return null;
    }, [pgrstInitError, runsQuery.error]);

    const isLoading = isPgrstLoading || isSessionPending || runsQuery.isLoading;

    return {
        runs: runsQuery.data?.data ?? [],
        count: runsQuery.data?.count ?? 0,
        data: defaultNull(runsQuery.data?.data),
        error,
        isLoading,
        isFetching: runsQuery.isFetching,
    };
}

export type TimelineRun = Omit<MonitorRun, "monitor">;

export const TIMELINE_RUNS = 40;

/**
 * The latest Runs of a Monitor, newest first. Refetches every few seconds
 * while one of them is still running, so its verdict appears by itself.
 */
export function useMonitorTimeline(monitorId?: string, limit = TIMELINE_RUNS) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<TimelineRun[]>({
        queryKey: [Entity.monitorRun, Operation.timeline, monitorId, limit],
        queryFn: async () => {
            if (!pgrst || !monitorId) return [];
            const { data, error } = await pgrst
                .from("monitor_runs")
                .select(runBaseCols.join())
                .eq("run_steps.phase", "plan")
                .eq("monitor_id", monitorId)
                .order("created_at", { ascending: false })
                .limit(limit);
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as TimelineRun[];
        },
        enabled: !!pgrst && !!monitorId,
        refetchInterval: q => (q.state.data?.some(isRunning) ? 3_000 : false),
    });

    // A Run that finishes can change more than the timeline: the Monitor's
    // Watch Plan, its Changes, its Macro versions. That is true of every Run,
    // whoever started it (the create form, the schedule, another tab), so the
    // refresh hangs off the timeline rather than off the Run now button.
    const queryClient = useQueryClient();
    const running = query.data?.some(isRunning) ?? false;
    const wasRunning = React.useRef(false);
    React.useEffect(() => {
        if (wasRunning.current && !running) {
            for (const entity of [
                Entity.monitor,
                Entity.change,
                Entity.monitorState,
                Entity.capture,
                // A Run can repair the Macro, which adds a version.
                "macros",
            ]) {
                void queryClient.invalidateQueries({
                    queryKey: [entity],
                    exact: false,
                });
            }
        }
        wasRunning.current = running;
    }, [running, queryClient]);

    return {
        runs: query.data ?? [],
        isLoading: isPgrstLoading || query.isLoading,
        error: query.error,
    };
}

/** One Run with its Monitor's name, or null when it is not the viewer's. */
export function useRun(runId?: string) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<MonitorRun | null>({
        queryKey: [Entity.monitorRun, Operation.get, runId],
        queryFn: async () => {
            if (!pgrst || !runId) return null;
            const { data, error } = await pgrst
                .from("monitor_runs")
                .select(runCols)
                .eq("run_steps.phase", "plan")
                .eq("id", runId)
                .maybeSingle();
            if (error) throw new Error(error.message);
            return (data ?? null) as unknown as MonitorRun | null;
        },
        enabled: !!pgrst && !!runId,
        refetchInterval: q =>
            q.state.data && isRunning(q.state.data) ? 2_000 : false,
    });

    return {
        run: query.data ?? null,
        isLoading: isPgrstLoading || query.isLoading,
        error: query.error,
    };
}

export type CaptureRow = {
    run_id: string;
    monitor_id: string;
    screenshot_key: string | null;
    blocks_key: string | null;
    meta: Record<string, unknown>;
    created_at: string;
};

/** The Capture of one Run (screenshot and blocks keys), or null. */
export function useCapture(runId?: string | null) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<CaptureRow | null>({
        queryKey: [Entity.capture, Operation.get, runId],
        queryFn: async () => {
            if (!pgrst || !runId) return null;
            const { data, error } = await pgrst
                .from("captures")
                .select(
                    "run_id,monitor_id,screenshot_key,blocks_key,meta,created_at",
                )
                .eq("run_id", runId)
                .maybeSingle();
            if (error) throw new Error(error.message);
            return (data ?? null) as unknown as CaptureRow | null;
        },
        enabled: !!pgrst && !!runId,
    });

    return {
        capture: query.data ?? null,
        isLoading: isPgrstLoading || (!!runId && query.isLoading),
    };
}

export type RunNowPhase = "idle" | "starting" | "running" | "done" | "error";

const POLL_MS = 1_500;
const RUN_TIMEOUT_MS = 5 * 60_000;

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Starts a Run through the scheduler admin API (server action) and polls it
 * until it succeeds or fails. `start` resolves with the final RunStatus (or
 * null when it could not start or timed out; `error` then says why), and
 * every Run, Change, Capture and state query is refreshed afterwards.
 */
export function useRunNow(monitorId?: string) {
    const queryClient = useQueryClient();
    const [phase, setPhase] = React.useState<RunNowPhase>("idle");
    const [run, setRun] = React.useState<RunStatus | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const alive = React.useRef(true);

    React.useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const refresh = React.useCallback(() => {
        for (const entity of [
            Entity.monitorRun,
            Entity.change,
            Entity.monitor,
            Entity.monitorState,
            Entity.capture,
        ]) {
            void queryClient.invalidateQueries({
                queryKey: [entity],
                exact: false,
            });
        }
    }, [queryClient]);

    const start = React.useCallback(
        async (
            trigger: "manual" | "confirm" = "manual",
            id: string | undefined = monitorId,
        ): Promise<RunStatus | null> => {
            if (!id) return null;
            setPhase("starting");
            setRun(null);
            setError(null);

            const started = await runNowAction(id, trigger);
            if (!started.ok) {
                if (alive.current) {
                    setPhase("error");
                    setError(started.error);
                }
                return null;
            }
            refresh();
            if (alive.current) setPhase("running");

            const deadline = Date.now() + RUN_TIMEOUT_MS;
            while (Date.now() < deadline) {
                await wait(POLL_MS);
                if (!alive.current) return null;
                const polled = await getRunAction(id, started.data.run_id);
                if (!polled.ok) continue;
                setRun(polled.data);
                if (
                    polled.data.status === "succeeded" ||
                    polled.data.status === "failed"
                ) {
                    setPhase("done");
                    refresh();
                    return polled.data;
                }
            }
            setPhase("error");
            setError(
                "The Run is taking longer than expected. Check the Runs page later.",
            );
            refresh();
            return null;
        },
        [monitorId, refresh],
    );

    const reset = React.useCallback(() => {
        setPhase("idle");
        setRun(null);
        setError(null);
    }, []);

    return {
        start,
        reset,
        phase,
        run,
        error,
        isRunning: phase === "starting" || phase === "running",
    };
}
