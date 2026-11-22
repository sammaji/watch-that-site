"use server";

import { sql } from "@watchthatsite/db/pool";
import { guarded, type ActionResult } from "./guard";

/**
 * Deletes a Monitor together with its secrets' encrypted values. Deleting the
 * `monitors` row through PostgREST would cascade to `monitor_secrets` but
 * leave the sealed values behind in `secrets`, which nothing points at then.
 */
export async function deleteMonitorAction(
    monitorId: string,
): Promise<ActionResult<{ ok: true }>> {
    return guarded(monitorId, async () => {
        await sql.begin(async tx => {
            const held = await tx<{ secretId: string }[]>`
                SELECT secret_id FROM monitor_secrets WHERE monitor_id = ${monitorId}
            `;
            await tx`DELETE FROM monitors WHERE id = ${monitorId}`;
            if (held.length > 0) {
                await tx`
                    DELETE FROM secrets
                    WHERE id IN ${tx(held.map(row => row.secretId))}
                `;
            }
        });
        return { ok: true as const };
    });
}
