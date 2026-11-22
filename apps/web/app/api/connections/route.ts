import { handle, readJson } from "@/lib/connections/http";
import {
    countCheck,
    createConnection,
    createSchema,
    ensurePlatformConnection,
    getPlatformCredit,
    listConnections,
    parseBody,
} from "@/lib/connections/service";

// GET /api/connections -> { connections, credit }: the platform credit first,
// then the owner's own connections, each with its key's status from the
// gateway; `credit` is what is left of the platform credit (null when the
// gateway cannot say), for the app's low-credit note.
export function GET() {
    return handle(async userId => {
        // The credit connection appears the first time it is needed. Without
        // the gateway the list still loads, and the next request tries again.
        await ensurePlatformConnection(userId).catch(error =>
            console.error(
                "[connections] could not set up the platform credit:",
                error instanceof Error ? error.message : "unknown error",
            ),
        );
        const connections = await listConnections(userId);
        return {
            connections,
            credit: await getPlatformCredit(userId),
        };
    });
}

// POST /api/connections { kind, name, baseUrl?, apiKey?, fields?, deployments? }
// -> the new connection with its status from the gateway and the models its
// key lists enabled. Settings the gateway refuses are a 400 and leave
// nothing behind.
export async function POST(request: Request) {
    const body = await readJson(request);
    return handle(async userId => {
        const input = parseBody(createSchema, body);
        countCheck(userId);
        return createConnection(userId, input);
    });
}
