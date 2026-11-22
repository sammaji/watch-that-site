import { handle, readJson } from "@/lib/connections/http";
import { ConnectionError } from "@/lib/connections/service";
import { sql } from "@watchthatsite/db/pool";
import { DEFAULT_UTILITY_MODEL } from "@watchthatsite/types";

/**
 * GET /api/settings  -> the account's settings
 * PUT /api/settings  { utility_connection_id, utility_model } (both null: the default)
 *
 * The utility model runs small jobs that are not a Monitor's, such as
 * suggesting Instructions for a new Monitor's page.
 */

type Settings = {
    utility_connection_id: string | null;
    utility_model: string | null;
    default_utility_model: string;
};

async function read(userId: string): Promise<Settings> {
    const rows = await sql<
        { utilityConnectionId: string | null; utilityModel: string | null }[]
    >`
        SELECT utility_connection_id, utility_model
        FROM user_settings WHERE user_id = ${userId}
    `;
    return {
        utility_connection_id: rows[0]?.utilityConnectionId ?? null,
        utility_model: rows[0]?.utilityModel ?? null,
        default_utility_model: DEFAULT_UTILITY_MODEL,
    };
}

export async function GET() {
    return handle(read);
}

export async function PUT(request: Request) {
    const body = (await readJson(request)) as {
        utility_connection_id?: unknown;
        utility_model?: unknown;
    } | null;
    return handle(async userId => {
        const connectionId = body?.utility_connection_id ?? null;
        const model = body?.utility_model ?? null;
        if (
            (connectionId !== null && typeof connectionId !== "string") ||
            (model !== null &&
                (typeof model !== "string" || model.length > 200)) ||
            (connectionId === null) !== (model === null || model === "")
        ) {
            throw new ConnectionError(
                400,
                "Choose both a connection and a model, or neither.",
            );
        }
        if (connectionId) {
            const own = await sql`
                SELECT 1 FROM provider_connections
                WHERE id = ${connectionId} AND user_id = ${userId}
            `.catch(() => []);
            if (own.length === 0) {
                throw new ConnectionError(404, "There is no such connection.");
            }
        }
        await sql`
            INSERT INTO user_settings (user_id, utility_connection_id, utility_model)
            VALUES (${userId}, ${connectionId as string | null}, ${(model as string | null) || null})
            ON CONFLICT (user_id) DO UPDATE SET
                utility_connection_id = EXCLUDED.utility_connection_id,
                utility_model = EXCLUDED.utility_model,
                updated_at = NOW()
        `;
        return read(userId);
    });
}
