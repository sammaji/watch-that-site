import "server-only";

import type {
    AgentError as AgentErrorBody,
    RecordMacroRequest,
    RecordMacroResponse,
    SuggestRequest,
    SuggestResponse,
    TestMacroRequest,
    TestMacroResponse,
} from "@watchthatsite/types";

/**
 * Server-side client for the browser worker's agent API (the bodies are in
 * packages/types/src/protocol.ts). Every call carries the AGENT_TOKEN bearer,
 * so it must only ever run on the server, after the caller's ownership of the
 * Monitor has been checked.
 */

export class AgentError extends Error {
    constructor(
        readonly status: number,
        /** The agent API's error code, or `unreachable`. */
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "AgentError";
    }
}

/** What to tell the owner for the codes they can do something about. */
const OWNER_MESSAGE: Record<string, string> = {
    no_connection:
        "This Monitor has no model connection, so the agent cannot run. Add one in Settings → Connections, then choose it under More options.",
    unauthorized:
        "The web app is not allowed to reach the agent. Check that AGENT_TOKEN is the same for the web app and the browser worker.",
};

function config(): { url: string; token: string } {
    const url = process.env.AGENT_URL ?? "http://127.0.0.1:5220";
    const token = process.env.AGENT_TOKEN;
    if (!token) {
        throw new AgentError(
            500,
            "not_configured",
            "AGENT_TOKEN is not configured.",
        );
    }
    return { url: url.replace(/\/+$/, ""), token };
}

async function call<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
): Promise<T> {
    const { url, token } = config();
    let response: Response;
    try {
        response = await fetch(`${url}${path}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const timedOut =
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AgentError(
            502,
            "unreachable",
            timedOut ?
                "The agent took too long to answer. Try again."
            :   "The agent is not reachable right now. Try again in a minute.",
        );
    }
    const text = await response.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    if (!response.ok) {
        const error = (json as AgentErrorBody | null)?.error;
        const code = error?.code ?? "internal_error";
        throw new AgentError(
            response.status,
            code,
            OWNER_MESSAGE[code] ??
                error?.message ??
                `The agent responded ${response.status}.`,
        );
    }
    return json as T;
}

export const agent = {
    /** Starts a recording and returns at once; the macros row is polled. */
    recordMacro: (body: RecordMacroRequest) =>
        call<RecordMacroResponse>("/internal/macros/record", body, 30_000),
    /** Replays the steps once, without a model, and waits for the result. */
    testMacro: (body: TestMacroRequest) =>
        call<TestMacroResponse>("/internal/macros/test", body, 5 * 60_000),
    /** Opens the URL and has the utility model suggest a name and Instructions. */
    suggest: (body: SuggestRequest) =>
        call<SuggestResponse>("/internal/suggest", body, 90_000),
};
