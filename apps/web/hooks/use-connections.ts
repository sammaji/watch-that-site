"use client";

import {
    useMutation,
    useQuery,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
import { authClient } from "@watchthatsite/auth/client";
import type { PlatformCredit, ProviderConnection } from "@watchthatsite/types";
import { toast } from "sonner";

/**
 * The signed-in user's model connections, read and changed through
 * `/api/connections`. Keys never reach the browser: a connection carries only
 * `api_key_hint`.
 */

export const connectionKeys = {
    /** Every list: the key to invalidate after a change. */
    lists: ["provider_connections", "list"] as const,
    list: (userId: string | undefined) =>
        ["provider_connections", "list", userId] as const,
    /** What the provider lists for one connection (the models editor). */
    models: (id: string) => ["provider_connections", "models", id] as const,
};

/** What `GET /api/connections` answers. */
export type ConnectionList = {
    /** The platform credit first, then enabled connections, then oldest first. */
    connections: ProviderConnection[];
    /** What is left of the platform credit; `null` when the gateway cannot say. */
    credit: PlatformCredit | null;
};

/** What `GET /api/connections/:id/models` answers. */
export type ConnectionModels = {
    /** Gateway model strings the key can use; empty when it cannot list them. */
    models: string[];
    /** Why the models could not be listed, in words a person can act on. */
    error: string | null;
};

/**
 * What the add/edit form sends to build the gateway key: the provider (or the
 * API a custom endpoint speaks), and the credentials and settings it asks for
 * (see `lib/connections/providers.ts`).
 */
export type ConnectionCredentials = {
    kind: string;
    /** A custom endpoint's URL; `null` for a provider's own endpoint. */
    baseUrl?: string | null;
    apiKey?: string;
    /** The provider's own fields, secret or not. */
    fields?: Record<string, string>;
    /** Model name → Azure deployment or Bedrock inference profile. */
    deployments?: Record<string, string>;
};

export type CreateConnectionInput = ConnectionCredentials & { name: string };

export type UpdateConnectionInput = Omit<
    Partial<ConnectionCredentials>,
    "kind"
> & {
    id: string;
    name?: string;
    models?: string[];
    defaultModel?: string | null;
    enabled?: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        cache: "no-store",
        ...init,
        headers:
            init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const body = (await response.json().catch(() => null)) as
        (T & { error?: string }) | null;
    if (!response.ok || body === null) {
        throw new Error(
            body?.error ?? `The request failed (${response.status}).`,
        );
    }
    return body;
}

function refresh(queryClient: QueryClient) {
    return queryClient.invalidateQueries({ queryKey: connectionKeys.lists });
}

/** The user's connections (the platform credit first) and what is left of the credit. */
export function useConnections(): {
    data: ProviderConnection[] | undefined;
    credit: PlatformCredit | null;
    isLoading: boolean;
    error: Error | null;
} {
    const { data: session, isPending: isSessionPending } =
        authClient.useSession();
    const userId = session?.user?.id;

    const query = useQuery<ConnectionList, Error>({
        queryKey: connectionKeys.list(userId),
        queryFn: () => request<ConnectionList>("/api/connections"),
        enabled: !!userId,
    });

    return {
        data: query.data?.connections,
        credit: query.data?.credit ?? null,
        isLoading: isSessionPending || query.isLoading,
        error: query.error,
    };
}

/**
 * Whether a connection can run a Monitor now: enabled, with a model, and
 * either a key the gateway does not report failing or credit left.
 */
export function isUsable(
    connection: ProviderConnection,
    credit: PlatformCredit | null,
): boolean {
    if (!connection.enabled || connection.models.length === 0) return false;
    if (!connection.managed) return connection.status?.state !== "failing";
    return !credit || credit.left_usd > 0;
}

export function useCreateConnection() {
    const queryClient = useQueryClient();
    return useMutation<ProviderConnection, Error, CreateConnectionInput>({
        mutationFn: input =>
            request<ProviderConnection>("/api/connections", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        onSuccess: () => refresh(queryClient),
    });
}

export function useUpdateConnection() {
    const queryClient = useQueryClient();
    return useMutation<ProviderConnection, Error, UpdateConnectionInput>({
        mutationFn: ({ id, ...patch }) =>
            request<ProviderConnection>(`/api/connections/${id}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            }),
        onSuccess: () => refresh(queryClient),
    });
}

export function useDeleteConnection() {
    const queryClient = useQueryClient();
    return useMutation<{ ok: true }, Error, string>({
        mutationFn: id =>
            request<{ ok: true }>(`/api/connections/${id}`, {
                method: "DELETE",
            }),
        onSuccess: async () => {
            await refresh(queryClient);
            toast.success("Connection deleted");
        },
        onError: err => toast.error(err.message),
    });
}
