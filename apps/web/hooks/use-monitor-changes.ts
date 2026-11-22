"use client";

import { useQuery } from "@tanstack/react-query";
import { authClient } from "@watchthatsite/auth/client";
import { usePostgrest } from "@watchthatsite/auth/postgrest";
import type {
    AgentVerdict,
    ChangeStatus,
    Magnitude,
} from "@watchthatsite/types";
import { Entity, Operation } from "./keys";

/** A `changes` row as the lists read it (the Change Record lives in R2). */
export type ChangeRow = {
    id: string;
    monitor_id: string;
    run_id: string;
    from_run_id: string;
    status: ChangeStatus;
    suppressed_by: string[];
    magnitude: Partial<Magnitude>;
    /** The agent's one-sentence answer. */
    summary: string | null;
    item_count: number;
    agent: Partial<AgentVerdict> | null;
    user_feedback: "useful" | "noise" | null;
    viewed_at: string | null;
    notified_at: string | null;
    created_at: string;
};

export const changeCols = [
    "id",
    "monitor_id",
    "run_id",
    "from_run_id",
    "status",
    "suppressed_by",
    "magnitude",
    "summary",
    "item_count",
    "agent",
    "user_feedback",
    "viewed_at",
    "notified_at",
    "created_at",
].join();

/**
 * One page of a Monitor's Changes, newest first. Suppressed Changes (Noise)
 * are left out unless asked for; the filter runs in PostgREST.
 */
export function useMonitorChanges({
    monitorId,
    includeSuppressed = false,
    page = 1,
    pageSize = 20,
}: {
    monitorId?: string;
    includeSuppressed?: boolean;
    page?: number;
    pageSize?: number;
}) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<{ data: ChangeRow[]; count: number }>({
        queryKey: [
            Entity.change,
            Operation.list,
            monitorId,
            includeSuppressed,
            page,
            pageSize,
        ],
        queryFn: async () => {
            if (!pgrst || !monitorId) return { data: [], count: 0 };
            const offset = (page - 1) * pageSize;
            const q = pgrst
                .from("changes")
                .select(changeCols, { count: "exact" })
                .eq("monitor_id", monitorId)
                .order("created_at", { ascending: false })
                .range(offset, offset + pageSize - 1);
            if (!includeSuppressed) q.in("status", ["change", "pending"]);
            const { data, error, count } = await q;
            if (error) throw new Error(error.message);
            return {
                data: (data ?? []) as unknown as ChangeRow[],
                count: count ?? 0,
            };
        },
        enabled: !!pgrst && !!monitorId,
        placeholderData: previous => previous,
    });

    return {
        changes: query.data?.data ?? [],
        count: query.data?.count ?? 0,
        isLoading: isPgrstLoading || query.isLoading,
        isFetching: query.isFetching,
        error: query.error,
    };
}

export type RecentChange = ChangeRow & {
    monitor: { name: string; url: string } | null;
};

/** The newest reported Changes across every Monitor of the active scope. */
export function useRecentChanges(limit = 8) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();
    const { data: session, isPending: isSessionPending } =
        authClient.useSession();
    const userId = session?.user?.id;

    const query = useQuery<RecentChange[]>({
        queryKey: [Entity.change, "recent", userId, limit],
        queryFn: async () => {
            if (!pgrst || !userId) return [];
            const q = pgrst
                .from("changes")
                .select(`${changeCols},monitor:monitors(name,url)`)
                .eq("status", "change")
                .order("created_at", { ascending: false })
                .limit(limit);
            q.eq("user_id", userId);
            const { data, error } = await q;
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as RecentChange[];
        },
        enabled: !!pgrst && !!userId,
    });

    return {
        changes: query.data ?? [],
        isLoading: isPgrstLoading || isSessionPending || query.isLoading,
        error: query.error,
    };
}

export type FailingMonitor = {
    monitor_id: string;
    consecutive_failures: number;
    monitor: { name: string; url: string } | null;
    /** Why the latest failed Run failed, when known. */
    reason: string | null;
};

type FailedRun = {
    monitor_id: string;
    error: { message?: string } | null;
    invalid_reason: string | null;
};

/** Monitors whose latest Runs failed, worst streak first. */
export function useFailingMonitors() {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();
    const { data: session, isPending: isSessionPending } =
        authClient.useSession();
    const userId = session?.user?.id;

    const query = useQuery<FailingMonitor[]>({
        queryKey: [Entity.monitorState, "failing", userId],
        queryFn: async () => {
            if (!pgrst || !userId) return [];
            const q = pgrst
                .from("monitor_state")
                .select(
                    "monitor_id,consecutive_failures,monitor:monitors(name,url)",
                )
                .gt("consecutive_failures", 0)
                .order("consecutive_failures", { ascending: false })
                .limit(20);
            q.eq("user_id", userId);
            const { data, error } = await q;
            if (error) throw new Error(error.message);
            const rows = (data ?? []) as unknown as Omit<
                FailingMonitor,
                "reason"
            >[];
            if (rows.length === 0) return [];

            const failed = await pgrst
                .from("monitor_runs")
                .select("monitor_id,error,invalid_reason")
                .eq("status", "failed")
                .in(
                    "monitor_id",
                    rows.map(r => r.monitor_id),
                )
                .order("created_at", { ascending: false })
                .limit(100);
            const reasons = new Map<string, string>();
            for (const run of (failed.data ?? []) as unknown as FailedRun[]) {
                if (reasons.has(run.monitor_id)) continue;
                const reason =
                    run.error?.message ??
                    run.invalid_reason?.replace(/_/g, " ") ??
                    "";
                if (reason) reasons.set(run.monitor_id, reason);
            }
            return rows.map(r => ({
                ...r,
                reason: reasons.get(r.monitor_id) ?? null,
            }));
        },
        enabled: !!pgrst && !!userId,
    });

    return {
        monitors: query.data ?? [],
        isLoading: isPgrstLoading || isSessionPending || query.isLoading,
        error: query.error,
    };
}
