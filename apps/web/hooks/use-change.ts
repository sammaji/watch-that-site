"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePostgrest } from "@watchthatsite/auth/postgrest";
import type {
    AgentVerdict,
    ChangeRecord,
    ChangeStatus,
    StoredBlocks,
    WatchPlan,
} from "@watchthatsite/types";
import * as React from "react";

/**
 * Data for the Change view (`app/(app)/changes/[id]`): the `changes` row and
 * its neighbours through PostgREST, and the Change Record and Capture blocks
 * through `/api/v1/objects/{key}`.
 *
 * The React Query keys live here (not in `hooks/keys.ts`). Everything under
 * `["changes", ...]` is invalidated when the viewer changes a row, so any
 * Changes list elsewhere refreshes too.
 */
export const changeKeys = {
    all: ["changes"] as const,
    detail: (id: string) => ["changes", "get", id] as const,
    neighbours: (monitorId: string, createdAt: string) =>
        ["changes", "neighbours", monitorId, createdAt] as const,
    record: (key: string) => ["changes", "record", key] as const,
    blocks: (key: string) => ["captures", "blocks", key] as const,
    captures: (monitorId: string) => ["captures", "list", monitorId] as const,
    monitor: (monitorId: string) => ["changes", "monitor", monitorId] as const,
};

export type UserFeedback = "useful" | "noise";

export type ChangeRow = {
    id: string;
    monitor_id: string;
    run_id: string;
    from_run_id: string;
    status: ChangeStatus;
    suppressed_by: string[];
    magnitude: Record<string, number>;
    summary: string | null;
    item_count: number;
    agent: Partial<AgentVerdict> | null;
    record_key: string | null;
    user_feedback: UserFeedback | null;
    viewed_at: string | null;
    notified_at: string | null;
    created_at: string;
};

const changeCols = [
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
    "record_key",
    "user_feedback",
    "viewed_at",
    "notified_at",
    "created_at",
].join();

export type ChangeMonitor = {
    id: string;
    name: string;
    url: string;
    instructions: string;
    watch_plan: WatchPlan | null;
};

export type CaptureRow = {
    run_id: string;
    monitor_id: string;
    screenshot_key: string | null;
    blocks_key: string | null;
    created_at: string;
};

/** The browser URL of a private object (302 to a signed URL). */
export function objectUrl(key: string): string {
    return `/api/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Fetches a `.json.gz` object, gunzipped by the objects route. */
export async function fetchObjectJson<T>(key: string): Promise<T> {
    const response = await fetch(`${objectUrl(key)}?inline=1`, {
        cache: "no-store",
    });
    if (!response.ok) {
        throw new Error(
            response.status === 404 ?
                "This evidence is no longer stored."
            :   `Could not load evidence (${response.status}).`,
        );
    }
    return (await response.json()) as T;
}

type PostgrestState = ReturnType<typeof usePostgrest>;
type Postgrest = NonNullable<PostgrestState["data"]>;

const PostgrestContext = React.createContext<PostgrestState | null>(null);

/**
 * One PostgREST client (one token fetch) shared by every hook of a Change
 * view. Wrap the view in it; the hooks below read the client from it.
 */
export function ChangeDataProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const value = usePostgrest();
    return React.createElement(PostgrestContext.Provider, { value }, children);
}

function useChangePostgrest(): PostgrestState {
    const value = React.useContext(PostgrestContext);
    if (!value) throw new Error("Change hooks need a ChangeDataProvider.");
    return value;
}

type Neighbours = { prev: string | null; next: string | null };

async function fetchChangeRow(pgrst: Postgrest, id: string) {
    const { data, error } = await pgrst
        .from("changes")
        .select(changeCols)
        .eq("id", id)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as ChangeRow | null) ?? null;
}

async function fetchNeighbours(
    pgrst: Postgrest,
    row: Pick<ChangeRow, "monitor_id" | "created_at">,
): Promise<Neighbours> {
    const [prev, next] = await Promise.all([
        pgrst
            .from("changes")
            .select("id")
            .eq("monitor_id", row.monitor_id)
            .lt("created_at", row.created_at)
            .order("created_at", { ascending: false })
            .limit(1),
        pgrst
            .from("changes")
            .select("id")
            .eq("monitor_id", row.monitor_id)
            .gt("created_at", row.created_at)
            .order("created_at", { ascending: true })
            .limit(1),
    ]);
    if (prev.error) throw new Error(prev.error.message);
    if (next.error) throw new Error(next.error.message);
    const first = (rows: unknown) =>
        (rows as Array<{ id: string }> | null)?.[0]?.id ?? null;
    return { prev: first(prev.data), next: first(next.data) };
}

export function useChangeRow(id: string) {
    const { data: pgrst, error: pgrstError } = useChangePostgrest();
    const query = useQuery<ChangeRow | null>({
        queryKey: changeKeys.detail(id),
        queryFn: () => (pgrst ? fetchChangeRow(pgrst, id) : null),
        enabled: !!pgrst,
    });
    return {
        row: query.data ?? null,
        // Cached data (e.g. prefetched by the previous Change) renders at
        // once, before this mount's PostgREST client is ready.
        isLoading:
            query.data === undefined &&
            !pgrstError &&
            (!pgrst || query.isLoading),
        error: pgrstError?.message ?? query.error?.message ?? null,
    };
}

export function useChangeRecord(key: string | null | undefined) {
    const query = useQuery<ChangeRecord>({
        queryKey: changeKeys.record(key ?? ""),
        queryFn: () => fetchObjectJson<ChangeRecord>(key!),
        enabled: !!key,
        staleTime: Infinity,
        retry: 1,
    });
    return {
        record: query.data ?? null,
        isLoading: query.isLoading,
        error: query.error?.message ?? null,
    };
}

/** A Capture's stored blocks; immutable, so cached forever. */
export function useStoredBlocks(key: string | null | undefined) {
    const query = useQuery<StoredBlocks>({
        queryKey: changeKeys.blocks(key ?? ""),
        queryFn: () => fetchObjectJson<StoredBlocks>(key!),
        enabled: !!key,
        staleTime: Infinity,
        retry: 1,
    });
    return {
        blocks: query.data ?? null,
        isLoading: query.isLoading,
        error: query.error?.message ?? null,
    };
}

/** The older and newer Changes of the same Monitor, by created_at. */
export function useChangeNeighbours(row: ChangeRow | null) {
    const { data: pgrst } = useChangePostgrest();
    const queryClient = useQueryClient();
    const query = useQuery<Neighbours>({
        queryKey: changeKeys.neighbours(
            row?.monitor_id ?? "",
            row?.created_at ?? "",
        ),
        queryFn: () =>
            pgrst && row ?
                fetchNeighbours(pgrst, row)
            :   { prev: null, next: null },
        enabled: !!pgrst && !!row,
    });
    const neighbours = query.data;

    // Prefetch the neighbours' rows (and their neighbours), so Prev / Next
    // render the next Change without a loading state.
    React.useEffect(() => {
        if (!pgrst || !neighbours) return;
        for (const id of [neighbours.prev, neighbours.next]) {
            if (!id) continue;
            void queryClient
                .fetchQuery({
                    queryKey: changeKeys.detail(id),
                    queryFn: () => fetchChangeRow(pgrst, id),
                    staleTime: 30_000,
                })
                .then(next =>
                    next ?
                        queryClient.prefetchQuery({
                            queryKey: changeKeys.neighbours(
                                next.monitor_id,
                                next.created_at,
                            ),
                            queryFn: () => fetchNeighbours(pgrst, next),
                            staleTime: 30_000,
                        })
                    :   undefined,
                )
                .catch(() => undefined);
        }
    }, [pgrst, neighbours, queryClient]);

    return neighbours ?? { prev: null, next: null };
}

export function useChangeMonitor(monitorId: string | null | undefined) {
    const { data: pgrst } = useChangePostgrest();
    const query = useQuery<ChangeMonitor | null>({
        queryKey: changeKeys.monitor(monitorId ?? ""),
        queryFn: async () => {
            if (!pgrst || !monitorId) return null;
            const { data, error } = await pgrst
                .from("monitors")
                .select("id,name,url,instructions,watch_plan")
                .eq("id", monitorId)
                .maybeSingle();
            if (error) throw new Error(error.message);
            return (data as unknown as ChangeMonitor | null) ?? null;
        },
        enabled: !!pgrst && !!monitorId,
    });
    return { monitor: query.data ?? null, isLoading: query.isLoading };
}

export function useMonitorCaptures(
    monitorId: string | null | undefined,
    enabled: boolean,
) {
    const { data: pgrst } = useChangePostgrest();
    const query = useQuery<CaptureRow[]>({
        queryKey: changeKeys.captures(monitorId ?? ""),
        queryFn: async () => {
            if (!pgrst || !monitorId) return [];
            const { data, error } = await pgrst
                .from("captures")
                .select(
                    "run_id,monitor_id,screenshot_key,blocks_key,created_at",
                )
                .eq("monitor_id", monitorId)
                .order("created_at", { ascending: false })
                .limit(50);
            if (error) throw new Error(error.message);
            return (data as unknown as CaptureRow[] | null) ?? [];
        },
        enabled: enabled && !!pgrst && !!monitorId,
    });
    return {
        captures: query.data ?? [],
        isLoading: query.isLoading,
        error: query.error?.message ?? null,
    };
}

/** Change ids whose viewed_at this tab already stamped (survives remounts). */
const stampedViews = new Set<string>();

/**
 * Stamps `changes.viewed_at` the first time the viewer opens a Change, so
 * lists can tell read from unread. Runs once per Change per page load.
 */
export function useMarkViewed(row: ChangeRow | null) {
    const { data: pgrst } = useChangePostgrest();
    const queryClient = useQueryClient();
    React.useEffect(() => {
        if (!pgrst || !row || row.viewed_at || stampedViews.has(row.id)) return;
        stampedViews.add(row.id);
        void pgrst
            .from("changes")
            .update({ viewed_at: new Date().toISOString() })
            .eq("id", row.id)
            .then(({ error }) => {
                if (error) {
                    stampedViews.delete(row.id);
                    return;
                }
                void queryClient.invalidateQueries({
                    queryKey: changeKeys.all,
                });
            });
    }, [pgrst, row, queryClient]);
}

/** With `sectionId` set to ignore, marked as edited by a person. */
export function planIgnoring(plan: WatchPlan, sectionId: string): WatchPlan {
    return {
        ...plan,
        // "" says a person changed it last, so a re-plan keeps their choice.
        model: "",
        sections: plan.sections.map(section =>
            section.id === sectionId ?
                { ...section, how: "ignore" as const }
            :   section,
        ),
    };
}

/** Mutations the Change view makes: feedback and the two ways to ignore. */
export function useChangeMutations(changeId: string, monitorId: string | null) {
    const { data: pgrst } = useChangePostgrest();
    const queryClient = useQueryClient();

    const patchChange = async (fields: {
        user_feedback?: UserFeedback | null;
    }) => {
        if (!pgrst) throw new Error("Not connected yet. Try again in a moment.");
        const { error } = await pgrst
            .from("changes")
            .update(fields)
            .eq("id", changeId);
        if (error) throw new Error(error.message);
    };

    const invalidateChanges = () =>
        queryClient.invalidateQueries({ queryKey: changeKeys.all });

    const invalidateMonitor = async () => {
        await queryClient.invalidateQueries({
            queryKey: changeKeys.monitor(monitorId ?? ""),
        });
        // The Monitor screens' own queries.
        await queryClient.invalidateQueries({ queryKey: ["monitors"] });
    };

    const setFeedback = useMutation({
        mutationFn: (feedback: UserFeedback | null) =>
            patchChange({ user_feedback: feedback }),
        onSuccess: invalidateChanges,
    });

    /**
     * "Ignore changes like this", by sentence: replaces the Monitor's
     * Instructions with the edited text and marks this Change as Noise.
     */
    const saveInstructions = useMutation({
        mutationFn: async (instructions: string) => {
            if (!pgrst || !monitorId) {
                throw new Error("Not connected yet. Try again in a moment.");
            }
            const { error } = await pgrst
                .from("monitors")
                .update({ instructions })
                .eq("id", monitorId);
            if (error) throw new Error(error.message);
            await patchChange({ user_feedback: "noise" });
        },
        onSuccess: async () => {
            await invalidateMonitor();
            await invalidateChanges();
        },
    });

    /**
     * "Ignore changes like this", by Section: sets the Section to ignore in
     * the Monitor's Watch Plan (read fresh, so a choice made elsewhere
     * meanwhile is not lost) and marks this Change as Noise.
     */
    const ignoreSection = useMutation({
        mutationFn: async (sectionId: string) => {
            if (!pgrst || !monitorId) {
                throw new Error("Not connected yet. Try again in a moment.");
            }
            const current = await pgrst
                .from("monitors")
                .select("watch_plan")
                .eq("id", monitorId)
                .single();
            if (current.error) throw new Error(current.error.message);
            const plan = (current.data as { watch_plan: WatchPlan | null })
                .watch_plan;
            if (!plan?.sections.some(section => section.id === sectionId)) {
                throw new Error(
                    "The page has been planned again since this Change and that section is gone. Add a sentence to the Instructions instead.",
                );
            }
            const { error } = await pgrst
                .from("monitors")
                .update({ watch_plan: planIgnoring(plan, sectionId) })
                .eq("id", monitorId);
            if (error) throw new Error(error.message);
            await patchChange({ user_feedback: "noise" });
        },
        onSuccess: async () => {
            await invalidateMonitor();
            await invalidateChanges();
        },
    });

    return { setFeedback, saveInstructions, ignoreSection };
}
