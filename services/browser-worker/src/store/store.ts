import type {
    MacroSource,
    MacroStatus,
    MacroStep,
    ProviderKind,
    RunStepPhase,
    RunStepStatus,
} from "@watchthatsite/types";

/**
 * Everything the worker reads from and writes to Postgres, behind one
 * interface: Monitors, model connections and secrets (read), Macros and
 * run_steps (read and write). `PgStore` is the implementation.
 */

export interface Owner {
    userId: string;
}

/** The columns of a `monitors` row the worker uses. */
export interface MonitorRow extends Owner {
    id: string;
    name: string;
    url: string;
    instructions: string;
    connectionId: string | null;
    model: string | null;
    viewportW: number;
    viewportH: number;
    blockAds: boolean;
    extraWaitMs: number;
}

export interface MacroRow {
    id: string;
    monitorId: string;
    version: number;
    status: MacroStatus;
    source: MacroSource;
    goal: string;
    steps: MacroStep[];
    note: string;
}

/**
 * A model connection, resolved to a gateway request: every model call goes
 * through the Bifrost gateway with the account's virtual key.
 */
export interface ResolvedConnection {
    id: string;
    kind: ProviderKind;
    name: string;
    /** The gateway's OpenAI-compatible API (see `gatewayBaseUrl`). */
    baseUrl: string;
    /** The account's virtual key. */
    apiKey: string;
    /**
     * The gateway provider key to send the request with, so an owner with two
     * keys on the same provider gets the one this connection holds. `null`
     * for the platform credit, whose key the gateway's routing rules pin.
     */
    keyId?: string | null;
    /** The platform credit: a refused budget means the credit is used up. */
    managed?: boolean;
    /** A gateway model string, `<provider>/<model>`. */
    model: string;
}

/** The Monitor has no enabled connection with a model. */
export class NoConnectionError extends Error {
    constructor(
        message = "This Monitor has no usable model connection. Add a connection and choose a model for the Monitor.",
    ) {
        super(message);
        this.name = "NoConnectionError";
    }
}

/** What a run_steps row belongs to: a Run's trace or a recording's. */
export type StepSubject = Owner & {
    monitorId: string;
} & ({ runId: string; macroId: null } | { runId: null; macroId: string });

export interface RunStepInput {
    seq: number;
    phase: RunStepPhase;
    /** The Macro step type or the agent tool name. */
    kind: string;
    /** One line a person can read. */
    title: string;
    status: RunStepStatus;
    detail: Record<string, unknown>;
    screenshotKey: string | null;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
}

export interface Store {
    getMonitor(id: string): Promise<MonitorRow | null>;
    getMacro(id: string): Promise<MacroRow | null>;

    /** Names of the secrets a Monitor's Macro may type. Never the values. */
    secretNames(monitorId: string): Promise<string[]>;
    /** A secret's decrypted value, or null when the Monitor has none by that name. */
    readSecret(monitorId: string, name: string): Promise<string | null>;

    /**
     * The connection and model the Agent uses: the Monitor's own when both
     * are set and the connection is enabled, otherwise the owner's first
     * enabled connection with its default (or first enabled) model.
     * Throws NoConnectionError when there is none.
     */
    resolveConnection(
        args: Owner & { connectionId: string | null; model: string | null },
    ): Promise<ResolvedConnection>;

    /**
     * The owner's utility model (Your account → Utility model), for small
     * jobs that are not a Monitor's. When unset: the credit's mini model.
     */
    utilityModel(
        userId: string,
    ): Promise<{ connectionId: string | null; model: string | null }>;

    /** Inserts the next Macro version as `recording` and returns its id. */
    insertRecording(monitor: MonitorRow, goal: string): Promise<string>;
    finishRecording(
        macroId: string,
        outcome: {
            status: "draft" | "failed";
            steps: MacroStep[];
            note: string;
        },
    ): Promise<void>;
    /**
     * Inserts a repaired version as active and archives `old`, in one
     * transaction. Returns null, changing nothing, when `old` is no longer
     * the active version (the owner replaced it while the Run was going).
     */
    insertRepair(
        old: MacroRow,
        owner: Owner,
        steps: MacroStep[],
        note: string,
    ): Promise<string | null>;
    /** Fails recordings left behind by a worker that died. Returns how many. */
    failStaleRecordings(olderThanMs: number): Promise<number>;

    /** The next free `seq` for a Run's or a recording's steps. */
    nextSeq(subject: StepSubject): Promise<number>;
    /** Drops a Run's rows of the given phases, so a redelivered job starts clean. */
    clearRunSteps(runId: string, phases: RunStepPhase[]): Promise<void>;
    insertRunStep(subject: StepSubject, step: RunStepInput): Promise<void>;
}
