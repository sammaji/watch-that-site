"use client";

import {
    approveDraftAction,
    deleteSecretAction,
    discardMacroAction,
    putSecretAction,
    removeMacroAction,
    saveStepsAction,
    startRecordingAction,
} from "@/app/actions/macros";
import type { ActionResult } from "@/app/actions/guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePostgrest } from "@watchthatsite/auth/postgrest";
import type {
    Macro,
    MacroStep,
    MonitorSecret,
    TestMacroResponse,
} from "@watchthatsite/types";
import * as React from "react";

/**
 * A Monitor's Macro versions and secrets. Reads go through PostgREST (the
 * browser may read `macros` and `monitor_secrets`, never a secret's value);
 * every write goes through a server action.
 */
export const macroKeys = {
    all: ["macros"] as const,
    list: (monitorId: string) => ["macros", "list", monitorId] as const,
    secrets: (monitorId: string) =>
        ["monitor_secrets", "list", monitorId] as const,
};

const macroCols = [
    "id",
    "monitor_id",
    "version",
    "status",
    "source",
    "goal",
    "steps",
    "note",
    "created_at",
    "updated_at",
].join();

/** A recording that has not moved for this long has lost its worker. */
export const STALE_RECORDING_MS = 10 * 60_000;

export function isStaleRecording(macro: Macro, now = Date.now()): boolean {
    return (
        macro.status === "recording" &&
        now - new Date(macro.updated_at).getTime() > STALE_RECORDING_MS
    );
}

/** Unwraps a server action's result, throwing its message on failure. */
async function unwrap<T>(result: Promise<ActionResult<T>>): Promise<T> {
    const settled = await result;
    if (!settled.ok) throw new Error(settled.error);
    return settled.data;
}

/**
 * Every version of the Monitor's Macro, newest first, split into the roles
 * the Macro tab shows. Polls while the agent is recording.
 */
export function useMacros(monitorId?: string) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<Macro[]>({
        queryKey: macroKeys.list(monitorId ?? ""),
        queryFn: async () => {
            if (!pgrst || !monitorId) return [];
            const { data, error } = await pgrst
                .from("macros")
                .select(macroCols)
                .eq("monitor_id", monitorId)
                .order("version", { ascending: false })
                .limit(100);
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as Macro[];
        },
        enabled: !!pgrst && !!monitorId,
        refetchInterval: q =>
            q.state.data?.some(m => m.status === "recording") ? 1_500 : false,
    });

    const versions = React.useMemo(() => query.data ?? [], [query.data]);
    return {
        versions,
        active: versions.find(m => m.status === "active") ?? null,
        /** The newest of: a recording in flight, a draft, a failed recording. */
        pending:
            versions.find(
                m =>
                    m.status === "recording" ||
                    m.status === "draft" ||
                    m.status === "failed",
            ) ?? null,
        isLoading: isPgrstLoading || query.isLoading,
        error: query.error,
    };
}

/** The Monitor's secrets: names and hints only. */
export function useMonitorSecrets(monitorId?: string) {
    const { data: pgrst, isLoading: isPgrstLoading } = usePostgrest();

    const query = useQuery<MonitorSecret[]>({
        queryKey: macroKeys.secrets(monitorId ?? ""),
        queryFn: async () => {
            if (!pgrst || !monitorId) return [];
            const { data, error } = await pgrst
                .from("monitor_secrets")
                .select("id,monitor_id,name,hint,created_at")
                .eq("monitor_id", monitorId)
                .order("name", { ascending: true });
            if (error) throw new Error(error.message);
            return (data ?? []) as unknown as MonitorSecret[];
        },
        enabled: !!pgrst && !!monitorId,
    });

    return {
        secrets: query.data ?? [],
        isLoading: isPgrstLoading || query.isLoading,
        error: query.error,
    };
}

/** Replays steps once through the agent and reports how each one went. */
export async function testSteps(
    monitorId: string,
    steps: MacroStep[],
): Promise<TestMacroResponse> {
    const response = await fetch(`/api/monitors/${monitorId}/macro/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
        cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as
        (TestMacroResponse & { error?: string }) | null;
    if (!response.ok || !body) {
        throw new Error(
            (typeof body?.error === "string" && body.error) ||
                `The test could not run (${response.status}). Try again.`,
        );
    }
    return body;
}

/** The writes of the Macro tab. Each refreshes the lists it changes. */
export function useMacroMutations(monitorId: string) {
    const queryClient = useQueryClient();
    const refreshMacros = () =>
        queryClient.invalidateQueries({ queryKey: macroKeys.list(monitorId) });
    const refreshSecrets = () =>
        queryClient.invalidateQueries({
            queryKey: macroKeys.secrets(monitorId),
        });

    const startRecording = useMutation({
        mutationFn: (goal: string) =>
            unwrap(startRecordingAction(monitorId, goal)),
        onSuccess: refreshMacros,
    });
    const saveSteps = useMutation({
        mutationFn: (input: { steps: MacroStep[]; fromDraftId?: string }) =>
            unwrap(
                saveStepsAction(monitorId, input.steps, {
                    fromDraftId: input.fromDraftId,
                }),
            ),
        onSuccess: refreshMacros,
    });
    const approveDraft = useMutation({
        mutationFn: (macroId: string) =>
            unwrap(approveDraftAction(monitorId, macroId)),
        onSuccess: refreshMacros,
    });
    const discard = useMutation({
        mutationFn: (macroId: string) =>
            unwrap(discardMacroAction(monitorId, macroId)),
        onSuccess: refreshMacros,
    });
    const removeMacro = useMutation({
        mutationFn: () => unwrap(removeMacroAction(monitorId)),
        onSuccess: refreshMacros,
    });
    const putSecret = useMutation({
        mutationFn: (input: { name: string; value: string }) =>
            unwrap(putSecretAction(monitorId, input.name, input.value)),
        onSuccess: refreshSecrets,
    });
    const deleteSecret = useMutation({
        mutationFn: (name: string) =>
            unwrap(deleteSecretAction(monitorId, name)),
        onSuccess: refreshSecrets,
    });

    return {
        startRecording,
        saveSteps,
        approveDraft,
        discard,
        removeMacro,
        putSecret,
        deleteSecret,
    };
}
