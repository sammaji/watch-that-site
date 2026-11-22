import { getSecret } from "@watchthatsite/db/vault";
import {
    DEFAULT_UTILITY_MODEL,
    type MacroSource,
    type MacroStatus,
    type MacroStep,
    type ProviderKind,
    type RunStepPhase,
} from "@watchthatsite/types";
import type { Sql } from "postgres";
import {
    NoConnectionError,
    type MacroRow,
    type MonitorRow,
    type Owner,
    type ResolvedConnection,
    type RunStepInput,
    type StepSubject,
    type Store,
} from "./store.js";

type ConnectionRow = {
    id: string;
    kind: ProviderKind;
    name: string;
    gatewayKeyId: string | null;
    managed: boolean;
    modelsJson: string;
    defaultModel: string | null;
};

/**
 * Where the Agent reaches the model gateway: its OpenAI-compatible API at
 * `/v1`, which serves every provider through `provider/model` strings.
 */
export function gatewayBaseUrl(gatewayUrl: string): string {
    return `${gatewayUrl.replace(/\/+$/, "")}/v1`;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === UNIQUE_VIOLATION
    );
}

/** The models a connection has enabled, as stored (a JSON array of ids). */
function parseModels(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ?
                parsed.filter(
                    (m): m is string => typeof m === "string" && m !== "",
                )
            :   [];
    } catch {
        return [];
    }
}

/**
 * The Store on Postgres, through the shared `sql` client
 * (`@watchthatsite/db/pool`). That client renames columns to camelCase and
 * also rewrites the keys of JSON columns, so JSON is always selected as text
 * and parsed here: a Macro step's `timeout_ms` must stay `timeout_ms`.
 */
export class PgStore implements Store {
    /**
     * `gatewayUrl` is the Bifrost gateway every model call goes through
     * (BIFROST_URL). It is server configuration, never read from the
     * database; tests point it at a fake provider.
     */
    constructor(
        private readonly sql: Sql,
        private readonly gatewayUrl: string = process.env.BIFROST_URL ?? "",
    ) {}

    async getMonitor(id: string): Promise<MonitorRow | null> {
        const rows = await this.sql<MonitorRow[]>`
            SELECT id, user_id, name, url, instructions,
                   connection_id, model, viewport_w, viewport_h, block_ads,
                   extra_wait_ms
            FROM monitors WHERE id = ${id}
        `;
        return rows[0] ?? null;
    }

    async getMacro(id: string): Promise<MacroRow | null> {
        const rows = await this.sql<
            {
                id: string;
                monitorId: string;
                version: number;
                status: MacroStatus;
                source: MacroSource;
                goal: string;
                stepsJson: string;
                note: string;
            }[]
        >`
            SELECT id, monitor_id, version, status, source, goal,
                   steps::text AS steps_json, note
            FROM macros WHERE id = ${id}
        `;
        const row = rows[0];
        if (!row) return null;
        const { stepsJson, ...rest } = row;
        return { ...rest, steps: JSON.parse(stepsJson) as MacroStep[] };
    }

    async secretNames(monitorId: string): Promise<string[]> {
        const rows = await this.sql<{ name: string }[]>`
            SELECT name FROM monitor_secrets
            WHERE monitor_id = ${monitorId} ORDER BY name
        `;
        return rows.map(r => r.name);
    }

    async readSecret(monitorId: string, name: string): Promise<string | null> {
        const rows = await this.sql<{ secretId: string }[]>`
            SELECT secret_id FROM monitor_secrets
            WHERE monitor_id = ${monitorId} AND name = ${name}
        `;
        const row = rows[0];
        if (!row) return null;
        return getSecret(row.secretId, "macro_secret", this.sql);
    }

    async resolveConnection(
        args: Owner & { connectionId: string | null; model: string | null },
    ): Promise<ResolvedConnection> {
        // The owner's own connections before the platform credit, so a
        // Monitor without a connection runs on a key the owner added when
        // there is one, and on the credit otherwise.
        const rows = await this.sql<ConnectionRow[]>`
            SELECT id, kind, name, gateway_key_id, managed,
                   models::text AS models_json, default_model
            FROM provider_connections
            WHERE enabled AND user_id = ${args.userId}
            ORDER BY managed, created_at, id
        `;

        const fallbackModel = (row: ConnectionRow) =>
            row.defaultModel || parseModels(row.modelsJson)[0] || null;

        let chosen: ConnectionRow | undefined;
        let model: string | null = null;
        const own =
            args.connectionId ?
                rows.find(r => r.id === args.connectionId)
            :   undefined;
        if (own) {
            chosen = own;
            model = args.model || fallbackModel(own);
        } else {
            // The Monitor's connection is unset, disabled or gone: its model
            // name belongs to that connection, so it is not carried over.
            chosen = rows.find(r => fallbackModel(r) !== null);
            model = chosen ? fallbackModel(chosen) : null;
        }
        if (!chosen || !model) throw new NoConnectionError();

        // Every request goes to the gateway with the account's virtual key;
        // the gateway holds the provider keys.
        const keys = await this.sql<{ secretId: string }[]>`
            SELECT secret_id FROM virtual_keys WHERE user_id = ${args.userId}
        `;
        if (!keys[0] || !this.gatewayUrl) {
            throw new NoConnectionError(
                "This account has no access to the model gateway yet. Open WatchThatSite once to set it up, then run the Monitor again.",
            );
        }
        const apiKey = await getSecret(
            keys[0].secretId,
            "virtual_key",
            this.sql,
        );
        return {
            id: chosen.id,
            kind: chosen.kind,
            name: chosen.name,
            baseUrl: gatewayBaseUrl(this.gatewayUrl),
            apiKey,
            keyId: chosen.gatewayKeyId,
            managed: chosen.managed,
            model,
        };
    }

    async utilityModel(
        userId: string,
    ): Promise<{ connectionId: string | null; model: string | null }> {
        const rows = await this.sql<
            { connectionId: string | null; model: string | null }[]
        >`
            SELECT utility_connection_id AS connection_id, utility_model AS model
            FROM user_settings WHERE user_id = ${userId}
        `;
        if (rows[0]?.connectionId && rows[0].model) return rows[0];
        // Unset: the platform credit's small model.
        const credit = await this.sql<{ id: string }[]>`
            SELECT id FROM provider_connections
            WHERE user_id = ${userId} AND managed AND enabled
            LIMIT 1
        `;
        return {
            connectionId: credit[0]?.id ?? null,
            model: credit[0] ? DEFAULT_UTILITY_MODEL : null,
        };
    }

    async insertRecording(monitor: MonitorRow, goal: string): Promise<string> {
        // Two recordings started together would compute the same version;
        // the unique (monitor_id, version) index rejects one, which retries.
        for (let attempt = 0; ; attempt++) {
            try {
                const rows = await this.sql<{ id: string }[]>`
                    INSERT INTO macros
                        (monitor_id, user_id, version, status, source, goal)
                    SELECT ${monitor.id}, ${monitor.userId},
                           COALESCE(MAX(version), 0) + 1, 'recording', 'agent', ${goal}
                    FROM macros WHERE monitor_id = ${monitor.id}
                    RETURNING id
                `;
                return rows[0]!.id;
            } catch (err) {
                if (!isUniqueViolation(err) || attempt >= 3) throw err;
            }
        }
    }

    async finishRecording(
        macroId: string,
        outcome: {
            status: "draft" | "failed";
            steps: MacroStep[];
            note: string;
        },
    ): Promise<void> {
        // Only a row still recording moves on, so a recording the owner
        // discarded (or one already failed at shutdown) is left alone.
        await this.sql`
            UPDATE macros
            SET status = ${outcome.status},
                steps = ${this.sql.json(outcome.steps as never)},
                note = ${outcome.note},
                updated_at = NOW()
            WHERE id = ${macroId} AND status = 'recording'
        `;
    }

    async insertRepair(
        old: MacroRow,
        owner: Owner,
        steps: MacroStep[],
        note: string,
    ): Promise<string | null> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.sql.begin(async tx => {
                    const archived = await tx`
                        UPDATE macros SET status = 'archived', updated_at = NOW()
                        WHERE id = ${old.id} AND status = 'active'
                        RETURNING id
                    `;
                    if (archived.length === 0) return null;
                    const rows = await tx<{ id: string }[]>`
                        INSERT INTO macros
                            (monitor_id, user_id, version, status,
                             source, goal, steps, note)
                        SELECT ${old.monitorId}, ${owner.userId},
                               COALESCE(MAX(version), 0) + 1, 'active', 'repair',
                               ${old.goal}, ${tx.json(steps as never)}, ${note}
                        FROM macros WHERE monitor_id = ${old.monitorId}
                        RETURNING id
                    `;
                    return rows[0]!.id;
                });
            } catch (err) {
                if (!isUniqueViolation(err) || attempt >= 3) throw err;
            }
        }
    }

    async failStaleRecordings(olderThanMs: number): Promise<number> {
        const rows = await this.sql`
            UPDATE macros
            SET status = 'failed',
                note = 'Recording was interrupted before it finished. Start it again.',
                updated_at = NOW()
            WHERE status = 'recording'
              AND created_at < NOW() - make_interval(secs => ${olderThanMs / 1000})
            RETURNING id
        `;
        return rows.length;
    }

    async nextSeq(subject: StepSubject): Promise<number> {
        const rows =
            subject.runId !== null ?
                await this.sql<{ next: number }[]>`
                    SELECT COALESCE(MAX(seq), -1) + 1 AS next
                    FROM run_steps WHERE run_id = ${subject.runId}
                `
            :   await this.sql<{ next: number }[]>`
                    SELECT COALESCE(MAX(seq), -1) + 1 AS next
                    FROM run_steps WHERE macro_id = ${subject.macroId}
                `;
        return Number(rows[0]?.next ?? 0);
    }

    async clearRunSteps(runId: string, phases: RunStepPhase[]): Promise<void> {
        if (phases.length === 0) return;
        await this.sql`
            DELETE FROM run_steps
            WHERE run_id = ${runId} AND phase IN ${this.sql(phases)}
        `;
    }

    async insertRunStep(
        subject: StepSubject,
        step: RunStepInput,
    ): Promise<void> {
        await this.sql`
            INSERT INTO run_steps
                (run_id, macro_id, monitor_id, user_id, seq,
                 phase, kind, title, status, detail, screenshot_key,
                 input_tokens, output_tokens, duration_ms)
            VALUES
                (${subject.runId}, ${subject.macroId}, ${subject.monitorId},
                 ${subject.userId}, ${step.seq},
                 ${step.phase}, ${step.kind}, ${step.title.slice(0, 500)},
                 ${step.status}, ${this.sql.json(step.detail as never)},
                 ${step.screenshotKey}, ${Math.round(step.inputTokens)},
                 ${Math.round(step.outputTokens)}, ${Math.round(step.durationMs)})
        `;
    }
}
