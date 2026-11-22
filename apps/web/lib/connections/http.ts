import "server-only";

import { NextResponse } from "next/server";
import { ConnectionError, getUserId } from "./service";

/**
 * Runs a connections route handler for the signed-in user and turns what it
 * throws into a JSON error. Unexpected errors are logged by name only: their
 * message could quote a request that carried a key.
 */
export async function handle<T>(
    run: (userId: string) => Promise<T>,
): Promise<NextResponse> {
    try {
        const userId = await getUserId();
        if (!userId) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }
        return NextResponse.json(await run(userId));
    } catch (error) {
        if (error instanceof ConnectionError) {
            return NextResponse.json(
                { error: error.message },
                { status: error.status },
            );
        }
        console.error(
            "[connections] request failed:",
            error instanceof Error ? error.name : "unknown error",
            (error as { code?: unknown } | null)?.code ?? "",
        );
        return NextResponse.json(
            { error: "Something went wrong. Try again." },
            { status: 500 },
        );
    }
}

/** The request body as JSON, or `null` when it is missing or malformed. */
export async function readJson(request: Request): Promise<unknown> {
    return request.json().catch(() => null);
}
