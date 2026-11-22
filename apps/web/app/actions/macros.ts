"use server";

import { agent } from "@/lib/agent";
import { SECRET_NAME, checkSteps } from "@/lib/macro";
import { sql } from "@watchthatsite/db/pool";
import { putSecret, replaceSecret, secretHint } from "@watchthatsite/db/vault";
import type { MacroStep } from "@watchthatsite/types";
import { OwnerError, guarded, isUuid, type ActionResult } from "./guard";

/**
 * Server actions for a Monitor's Macro and the secrets it may type. The
 * browser can read `macros` and `monitor_secrets` through PostgREST but has no
 * grant to write them (and none at all on `secrets`), so every write goes
 * through here, after the ownership check in ./guard.
 */

const MAX_GOAL_LENGTH = 2_000;
const MAX_NOTE_LENGTH = 300;
const MAX_SECRET_LENGTH = 4_096;
const MAX_SECRETS = 20;

/** A recording that has not moved for this long has lost its worker. */
const STALE_RECORDING = "10 minutes";

/** Postgres unique_violation. */
function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23505"
    );
}

/** Asks the agent to record a Macro from a goal. Returns at once. */
export async function startRecordingAction(
    monitorId: string,
    goal: string,
): Promise<ActionResult<{ macro_id: string }>> {
    return guarded(monitorId, async () => {
        const trimmed = typeof goal === "string" ? goal.trim() : "";
        if (trimmed === "") {
            throw new OwnerError(
                "Say what the agent should do before each check, for example “Sign in and open Billing”.",
            );
        }
        if (trimmed.length > MAX_GOAL_LENGTH) {
            throw new OwnerError(
                `Keep the goal under ${MAX_GOAL_LENGTH} characters.`,
            );
        }
        const running = await sql`
            SELECT id FROM macros
            WHERE monitor_id = ${monitorId}
              AND status = 'recording'
              AND updated_at > NOW() - ${STALE_RECORDING}::interval
            LIMIT 1
        `;
        if (running.length > 0) {
            throw new OwnerError(
                "The agent is already recording pre-scraping for this Monitor. Wait for it to finish.",
            );
        }
        return agent.recordMacro({ monitor_id: monitorId, goal: trimmed });
    });
}

/**
 * Saves hand-edited steps as a new version made by a person. It becomes the
 * active version and the previous active one is archived, in one transaction.
 * `fromDraftId` is the agent's draft the edit started from, if any: it is
 * removed, since the saved version replaces it.
 */
export async function saveStepsAction(
    monitorId: string,
    steps: MacroStep[],
    options: { note?: string; fromDraftId?: string } = {},
): Promise<ActionResult<{ macro_id: string; version: number }>> {
    return guarded(monitorId, async monitor => {
        const checked = checkSteps(steps);
        if (!checked.ok) throw new OwnerError(checked.error);
        const note =
            typeof options.note === "string" && options.note.trim() !== "" ?
                options.note.trim().slice(0, MAX_NOTE_LENGTH)
            :   "Edited by hand";
        const fromDraftId =
            isUuid(options.fromDraftId) ? options.fromDraftId : null;

        const save = () =>
            sql.begin(async tx => {
                // One writer at a time per Monitor, so two saves cannot both
                // archive the same version or pick the same number.
                await tx`SELECT id FROM monitors WHERE id = ${monitorId} FOR UPDATE`;
                const base = await tx<{ goal: string }[]>`
                    SELECT goal FROM macros
                    WHERE monitor_id = ${monitorId}
                      AND (status = 'active' OR id = ${fromDraftId})
                    ORDER BY (id = ${fromDraftId}) DESC NULLS LAST
                    LIMIT 1
                `;
                const next = await tx<{ version: number }[]>`
                    SELECT COALESCE(MAX(version), 0) + 1 AS version
                    FROM macros WHERE monitor_id = ${monitorId}
                `;
                await tx`
                    UPDATE macros SET status = 'archived'
                    WHERE monitor_id = ${monitorId} AND status = 'active'
                `;
                if (fromDraftId) {
                    await tx`
                        DELETE FROM macros
                        WHERE id = ${fromDraftId}
                          AND monitor_id = ${monitorId}
                          AND status = 'draft'
                    `;
                }
                const inserted = await tx<{ id: string; version: number }[]>`
                    INSERT INTO macros
                        (monitor_id, user_id, version, status, source, goal, steps, note)
                    VALUES (
                        ${monitorId}, ${monitor.user_id},
                        ${next[0]!.version}, 'active', 'user',
                        ${base[0]?.goal ?? ""},
                        ${tx.json(checked.steps as never)}, ${note}
                    )
                    RETURNING id, version
                `;
                return inserted[0]!;
            });

        let row: { id: string; version: number };
        try {
            row = await save();
        } catch (error) {
            // The browser worker numbers its repairs without our lock; if it
            // took the same number, the next attempt reads the new maximum.
            if (!isUniqueViolation(error)) throw error;
            row = await save();
        }
        return { macro_id: row.id, version: row.version };
    });
}

/** Makes the agent's draft the active version; the previous one is archived. */
export async function approveDraftAction(
    monitorId: string,
    macroId: string,
): Promise<ActionResult<{ macro_id: string }>> {
    return guarded(monitorId, async () => {
        if (!isUuid(macroId)) throw new OwnerError("Pre-scraping not found.");
        await sql.begin(async tx => {
            await tx`SELECT id FROM monitors WHERE id = ${monitorId} FOR UPDATE`;
            const draft = await tx`
                SELECT id FROM macros
                WHERE id = ${macroId} AND monitor_id = ${monitorId} AND status = 'draft'
                FOR UPDATE
            `;
            if (draft.length === 0) {
                throw new OwnerError(
                    "This pre-scraping is no longer waiting for approval. Reload the page to see where it stands.",
                );
            }
            await tx`
                UPDATE macros SET status = 'archived'
                WHERE monitor_id = ${monitorId} AND status = 'active'
            `;
            await tx`UPDATE macros SET status = 'active' WHERE id = ${macroId}`;
        });
        return { macro_id: macroId };
    });
}

/**
 * Removes a draft, a failed recording, or a recording whose worker stopped
 * answering. Active and archived versions are history and stay.
 */
export async function discardMacroAction(
    monitorId: string,
    macroId: string,
): Promise<ActionResult<{ ok: true }>> {
    return guarded(monitorId, async () => {
        if (!isUuid(macroId)) throw new OwnerError("Pre-scraping not found.");
        const removed = await sql`
            DELETE FROM macros
            WHERE id = ${macroId}
              AND monitor_id = ${monitorId}
              AND (
                  status IN ('draft', 'failed')
                  OR (status = 'recording' AND updated_at < NOW() - ${STALE_RECORDING}::interval)
              )
            RETURNING id
        `;
        if (removed.length === 0) {
            throw new OwnerError(
                "This pre-scraping cannot be discarded: it is in use, or the agent is still recording it.",
            );
        }
        return { ok: true as const };
    });
}

/** Stops replaying a Macro: the active version is archived, none replaces it. */
export async function removeMacroAction(
    monitorId: string,
): Promise<ActionResult<{ ok: true }>> {
    return guarded(monitorId, async () => {
        await sql`
            UPDATE macros SET status = 'archived'
            WHERE monitor_id = ${monitorId} AND status = 'active'
        `;
        return { ok: true as const };
    });
}

/**
 * Saves a named secret the Macro may type as `{{secret:<name>}}`, replacing
 * the value when the name exists. The value is sealed in the vault; only a
 * hint (its last four characters) is stored where the browser can read it.
 */
export async function putSecretAction(
    monitorId: string,
    name: string,
    value: string,
): Promise<ActionResult<{ name: string; hint: string }>> {
    return guarded(monitorId, async monitor => {
        if (typeof name !== "string" || !SECRET_NAME.test(name)) {
            throw new OwnerError(
                "A secret's name starts with a lowercase letter and uses only lowercase letters, digits and underscores (up to 40), for example “password”.",
            );
        }
        if (typeof value !== "string" || value === "") {
            throw new OwnerError("Enter a value for the secret.");
        }
        if (value.length > MAX_SECRET_LENGTH) {
            throw new OwnerError(
                `A secret can be at most ${MAX_SECRET_LENGTH} characters.`,
            );
        }
        const hint = secretHint(value);
        await sql.begin(async tx => {
            await tx`SELECT id FROM monitors WHERE id = ${monitorId} FOR UPDATE`;
            const existing = await tx<{ secretId: string }[]>`
                SELECT secret_id FROM monitor_secrets
                WHERE monitor_id = ${monitorId} AND name = ${name}
            `;
            if (existing[0]) {
                await replaceSecret(
                    existing[0].secretId,
                    "macro_secret",
                    value,
                    tx,
                );
                await tx`
                    UPDATE monitor_secrets SET hint = ${hint}
                    WHERE monitor_id = ${monitorId} AND name = ${name}
                `;
                return;
            }
            const count = await tx<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM monitor_secrets
                WHERE monitor_id = ${monitorId}
            `;
            if ((count[0]?.n ?? 0) >= MAX_SECRETS) {
                throw new OwnerError(
                    `A Monitor can hold at most ${MAX_SECRETS} secrets. Delete one first.`,
                );
            }
            // The secret belongs to the Monitor's owner, so deleting the
            // account removes it.
            const secretId = await putSecret(
                { userId: monitor.user_id },
                "macro_secret",
                value,
                tx,
            );
            await tx`
                INSERT INTO monitor_secrets
                    (monitor_id, user_id, name, secret_id, hint)
                VALUES (
                    ${monitorId}, ${monitor.user_id},
                    ${name}, ${secretId}, ${hint}
                )
            `;
        });
        return { name, hint };
    });
}

export async function deleteSecretAction(
    monitorId: string,
    name: string,
): Promise<ActionResult<{ ok: true }>> {
    return guarded(monitorId, async () => {
        if (typeof name !== "string" || !SECRET_NAME.test(name)) {
            throw new OwnerError("Secret not found.");
        }
        await sql.begin(async tx => {
            const removed = await tx<{ secretId: string }[]>`
                DELETE FROM monitor_secrets
                WHERE monitor_id = ${monitorId} AND name = ${name}
                RETURNING secret_id
            `;
            if (removed[0]) {
                await tx`DELETE FROM secrets WHERE id = ${removed[0].secretId}`;
            }
        });
        return { ok: true as const };
    });
}
