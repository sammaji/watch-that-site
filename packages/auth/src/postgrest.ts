"use client";

import { _createPostgrestClient } from "@watchthatsite/db/postgrest";
import { useEffect, useState } from "react";
import { authClient } from "./client";

type GenericQueryError = {
    message: string;
};

// s converts an array of camelCase keys into camelCase:snake_case pairs
// for use in Postgrest select() clauses.
// e.g. ["fooBar", "bazQux"] -> ["foo_bar:fooBar", "baz_qux:bazQux"]
// e.g. select(s("fooBar", "bazQux")) -> "foo_bar:fooBar,baz_qux:bazQux"
export const s = (...x: string[]) =>
    x
        .map(f => {
            const s = f.replace(/([A-Z])/g, "_$1").toLowerCase();
            return s === f ? f : `${f}:${s}`;
        })
        .join();

type PostgrestClient = ReturnType<typeof _createPostgrestClient>;

export async function getPostgrestToken() {
    const { data, error } = await authClient.token();
    if (error) {
        throw error;
    }

    if (data?.token) {
        return data.token;
    }

    let headerToken: string | null = null;
    const session = await authClient.getSession({
        fetchOptions: {
            onSuccess: ctx => {
                headerToken = ctx.response.headers.get("set-auth-jwt");
            },
        },
    });

    if (session.error) {
        throw session.error;
    }

    if (headerToken) {
        return headerToken;
    }

    throw new Error("Better Auth did not return a PostgREST JWT.");
}

/**
 * Asynchronously fetches the current user's JWT and then creates a PostgrestClient
 * instance with that token for authorized database access.
 */
export const getPostgrestClient = async () => {
    let headerToken: string | null = null;
    const res = await Promise.race([
        authClient.token(),
        authClient.getSession({
            fetchOptions: {
                onSuccess: ctx => {
                    headerToken = ctx.response.headers.get("set-auth-jwt");
                },
            },
        }),
    ]);

    if (res.error) throw new Error("Failed to fetch authorization token");

    if (res.data) {
        if ("token" in res.data && typeof res.data.token === "string") {
            return _createPostgrestClient(res.data.token);
        }
        if (headerToken) {
            return _createPostgrestClient(headerToken);
        }
    }

    throw new Error("Failed to create PostgREST client.");
};

export function usePostgrest() {
    const [client, setClient] = useState<PostgrestClient | null>(null);
    const [error, setError] = useState<GenericQueryError | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function loadClient() {
            try {
                const client = await getPostgrestClient();
                if (isMounted) {
                    setClient(client);
                    setError(null);
                }
            } catch (err) {
                if (isMounted) {
                    setClient(null);
                    setError(
                        err instanceof Error ? err : (
                            new Error("Failed to create PostgREST client.")
                        ),
                    );
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        void loadClient();

        return () => {
            isMounted = false;
        };
    }, []);

    return { data: client, error, isLoading };
}
