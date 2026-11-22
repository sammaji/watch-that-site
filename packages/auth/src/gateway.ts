import { sql } from "@watchthatsite/db/pool";

/**
 * Removes what an account holds in the Bifrost model gateway: the provider
 * key (or custom provider) of each of its own connections, then its virtual
 * key. Runs before Better Auth deletes the user, so nothing is left in the
 * gateway once the account is gone; Postgres rows cascade from `users`.
 *
 * The web app's admin client (apps/web/lib/bifrost.ts) creates these; this is
 * the one call the auth package makes to the gateway, kept here so account
 * deletion works from any route. Throws when the gateway refuses, which
 * stops the deletion: the owner can try again rather than leave keys behind.
 */
export async function deleteGatewayAccount(userId: string): Promise<void> {
    const connections = await sql<
        { gatewayProvider: string; gatewayKeyId: string | null }[]
    >`
        SELECT gateway_provider, gateway_key_id FROM provider_connections
        WHERE user_id = ${userId} AND NOT managed
    `;
    const keys = await sql<{ bifrostId: string }[]>`
        SELECT bifrost_id FROM virtual_keys WHERE user_id = ${userId}
    `;
    if (connections.length === 0 && keys.length === 0) return;

    for (const c of connections) {
        if (c.gatewayProvider.startsWith("c-")) {
            await remove(
                `/api/providers/${encodeURIComponent(c.gatewayProvider)}`,
            );
        } else if (c.gatewayKeyId) {
            await remove(
                `/api/providers/${encodeURIComponent(c.gatewayProvider)}/keys/${encodeURIComponent(c.gatewayKeyId)}`,
            );
        }
    }
    for (const k of keys) {
        await remove(
            `/api/governance/virtual-keys/${encodeURIComponent(k.bifrostId)}`,
        );
    }
}

/** DELETE on the gateway's admin API; something already gone is fine. */
async function remove(path: string): Promise<void> {
    const base = process.env.BIFROST_URL?.trim().replace(/\/+$/, "");
    const user = process.env.BIFROST_ADMIN_USERNAME ?? "";
    const pass = process.env.BIFROST_ADMIN_PASSWORD ?? "";
    if (!base || !user || !pass) {
        throw new Error("The model gateway is not configured.");
    }
    const response = await fetch(`${base}${path}`, {
        method: "DELETE",
        headers: {
            Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && response.status !== 404) {
        throw new Error(`The model gateway answered ${response.status}.`);
    }
}
