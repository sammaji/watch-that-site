"use client";

import { deleteMonitorAction } from "@/app/actions/monitors";
import { defaultNull } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "@watchthatsite/auth/client";
import { usePostgrest } from "@watchthatsite/auth/postgrest";
import type { Monitor, MonitorStatus } from "@watchthatsite/types";
import * as React from "react";
import { toast } from "sonner";
import { Entity, Operation } from "./keys";
import { type GenericQueryError } from "./types";

export type { Monitor, MonitorStatus };

/** The columns a person edits: everything but ids, owner and timestamps. */
export type MonitorInput = Pick<
    Monitor,
    | "name"
    | "url"
    | "interval_minutes"
    | "instructions"
    | "connection_id"
    | "model"
    | "confirm_changes"
    | "urgency"
    | "block_ads"
    | "viewport_w"
    | "viewport_h"
>;

export type MonitorPatch = Partial<
    MonitorInput & Pick<Monitor, "status" | "snoozed_until" | "watch_plan">
>;

/** `monitor_state`: baselines and the failure streak, written by the scheduler. */
export type MonitorState = {
    monitor_id: string;
    previous_run_id: string | null;
    last_notified_run_id: string | null;
    pending_change_id: string | null;
    consecutive_failures: number;
    updated_at: string;
};

export const monitorCols = [
    "id",
    "user_id",
    "name",
    "url",
    "interval_minutes",
    "instructions",
    "connection_id",
    "model",
    "watch_plan",
    "confirm_changes",
    "urgency",
    "snoozed_until",
    "extra_wait_ms",
    "block_ads",
    "viewport_w",
    "viewport_h",
    "status",
    "created_at",
    "updated_at",
].join();

/** Invalidates every Monitor query (lists and single rows). */
export function useInvalidateMonitors() {
    const queryClient = useQueryClient();
    return React.useCallback(() => {
        void queryClient.invalidateQueries({
            queryKey: [Entity.monitor],
            exact: false,
        });
    }, [queryClient]);
}

export function useMonitors({
    page = 1,
    pageSize = 100,
}: { page?: number; pageSize?: number } = {}) {
    const invalidate = useInvalidateMonitors();

    const {
        data: pgrst,
        error: pgrstInitError,
        isLoading: isPgrstLoading,
    } = usePostgrest();

    const { data: session, isPending: isSessionPending } =
        authClient.useSession();

    const userId = session?.user?.id;

    const monitorsQuery = useQuery<{ data: Monitor[]; count: number }>({
        queryKey: [Entity.monitor, Operation.list, userId, page, pageSize],
        queryFn: async () => {
            if (!pgrst || !userId) return { data: [], count: 0 };

            const offset = (page - 1) * pageSize;
            const query = pgrst
                .from("monitors")
                .select(monitorCols, { count: "exact" })
                .order("updated_at", { ascending: false })
                .range(offset, offset + pageSize - 1);

            // Drafts belong to a create form that is still open.
            query.eq("user_id", userId).neq("status", "draft");

            const { data, error, count } = await query;
            if (error) throw new Error(error.message);
            return {
                data: (data ?? []) as unknown as Monitor[],
                count: count ?? 0,
            };
        },
        enabled: !!pgrst && !!userId,
    });

    const createMutation = useMutation({
        mutationFn: async (
            input: MonitorInput & { status?: MonitorStatus },
        ) => {
            if (!pgrst || !userId) {
                throw new Error("You are signed out. Sign in and retry.");
            }

            const { data, error } = await pgrst
                .from("monitors")
                .insert({
                    user_id: userId,
                    status: "active",
                    ...input,
                })
                .select(monitorCols)
                .single();
            if (error) throw new Error(error.message);
            return data as unknown as Monitor;
        },
        onSuccess: invalidate,
        onError: (err: Error) => toast.error(err.message),
    });

    const updateMutation = useMutation({
        mutationFn: async ({ id, ...patch }: MonitorPatch & { id: string }) => {
            if (!pgrst)
                throw new Error("Not connected yet. Try again in a moment.");

            const { data, error } = await pgrst
                .from("monitors")
                .update(patch)
                .eq("id", id)
                .select(monitorCols)
                .single();
            if (error) throw new Error(error.message);
            return data as unknown as Monitor;
        },
        onSuccess: invalidate,
        onError: (err: Error) => toast.error(err.message),
    });

    const deleteMutation = useMutation({
        // Through the server, so the Monitor's encrypted secrets are
        // removed with it (the browser cannot reach the vault).
        mutationFn: async (id: string) => {
            const result = await deleteMonitorAction(id);
            if (!result.ok) throw new Error(result.error);
        },
        onSuccess: invalidate,
        onError: (err: Error) => toast.error(err.message),
    });

    const error = React.useMemo<GenericQueryError | null>(() => {
        if (pgrstInitError) return { message: pgrstInitError.message };

        if (monitorsQuery.error !== null)
            return { message: monitorsQuery.error.message };

        if (createMutation.error !== null)
            return { message: createMutation.error.message };

        return null;
    }, [pgrstInitError, monitorsQuery.error, createMutation.error]);

    const isLoading =
        isPgrstLoading || isSessionPending || monitorsQuery.isLoading;

    const { mutate: updateMonitor } = updateMutation;
    const setMonitorStatus = React.useCallback(
        ({ id, status }: { id: string; status: MonitorStatus }) =>
            updateMonitor({ id, status }),
        [updateMonitor],
    );

    return {
        monitors: monitorsQuery.data?.data ?? [],
        count: monitorsQuery.data?.count ?? 0,
        data: defaultNull(monitorsQuery.data?.data),
        error,
        isLoading,
        isPending: isSessionPending || monitorsQuery.isPending,
        isFetching: monitorsQuery.isFetching,
        isStale: monitorsQuery.isStale,
        createMonitor: createMutation.mutate,
        createMonitorAsync: createMutation.mutateAsync,
        isCreating: createMutation.isPending,
        updateMonitor,
        updateMonitorAsync: updateMutation.mutateAsync,
        isUpdating: updateMutation.isPending,
        setMonitorStatus,
        deleteMonitor: deleteMutation.mutate,
        deleteMonitorAsync: deleteMutation.mutateAsync,
        isDeleting: deleteMutation.isPending,
    };
}

export function useMonitor(id?: string) {
    const {
        data: pgrst,
        error: pgrstInitError,
        isLoading: isPgrstLoading,
    } = usePostgrest();

    const query = useQuery<Monitor | null>({
        queryKey: [Entity.monitor, Operation.get, id],
        queryFn: async () => {
            if (!pgrst || !id) return null;
            const { data, error } = await pgrst
                .from("monitors")
                .select(monitorCols)
                .eq("id", id)
                .maybeSingle();
            if (error) throw new Error(error.message);
            return (data ?? null) as unknown as Monitor | null;
        },
        enabled: !!pgrst && !!id,
    });

    return {
        monitor: query.data ?? null,
        isLoading: isPgrstLoading || query.isLoading,
        error: pgrstInitError ?? query.error,
        refetch: query.refetch,
    };
}

/**
 * Patches one Monitor (instructions, snooze, status...) and refreshes every Monitor
 * query. Rejects on error; callers decide how to surface it.
 */
export function usePatchMonitor() {
    const { data: pgrst } = usePostgrest();
    const invalidate = useInvalidateMonitors();

    return useMutation({
        mutationFn: async ({
            id,
            patch,
        }: {
            id: string;
            patch: MonitorPatch;
        }) => {
            if (!pgrst)
                throw new Error("Not connected yet. Try again in a moment.");
            const { data, error } = await pgrst
                .from("monitors")
                .update(patch)
                .eq("id", id)
                .select(monitorCols)
                .single();
            if (error) throw new Error(error.message);
            return data as unknown as Monitor;
        },
        onSuccess: invalidate,
    });
}

/** The Monitor's `monitor_state` row, or null before its first Run. */
export function useMonitorState(monitorId?: string) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<MonitorState | null>({
        queryKey: [Entity.monitorState, Operation.get, monitorId],
        queryFn: async () => {
            if (!pgrst || !monitorId) return null;
            const { data, error } = await pgrst
                .from("monitor_state")
                .select(
                    "monitor_id,previous_run_id,last_notified_run_id,pending_change_id,consecutive_failures,updated_at",
                )
                .eq("monitor_id", monitorId)
                .maybeSingle();
            if (error) throw new Error(error.message);
            return (data ?? null) as unknown as MonitorState | null;
        },
        enabled: !!pgrst && !!monitorId,
    });

    return {
        state: query.data ?? null,
        isLoading: isPgrstLoading || query.isLoading,
        error: query.error,
    };
}
