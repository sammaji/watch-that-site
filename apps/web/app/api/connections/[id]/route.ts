import { handle, readJson } from "@/lib/connections/http";
import {
    countCheck,
    deleteConnection,
    parseBody,
    updateConnection,
    updateSchema,
} from "@/lib/connections/service";

type Context = { params: Promise<{ id: string }> };

// PATCH /api/connections/:id { name?, baseUrl?, apiKey?, fields?, deployments?,
// models?, defaultModel?, enabled? } -> the connection, with its key's status
// from the gateway when the credentials changed.
export async function PATCH(request: Request, { params }: Context) {
    const { id } = await params;
    const body = await readJson(request);
    return handle(async userId => {
        const input = parseBody(updateSchema, body);
        // New credentials reach the provider: the gateway lists models with them.
        if (
            input.apiKey ||
            input.fields !== undefined ||
            input.deployments !== undefined ||
            input.baseUrl !== undefined
        ) {
            countCheck(userId);
        }
        return updateConnection(userId, id, input);
    });
}

// DELETE /api/connections/:id -> removes the connection and its stored key.
export async function DELETE(_request: Request, { params }: Context) {
    const { id } = await params;
    return handle(async userId => {
        await deleteConnection(userId, id);
        return { ok: true };
    });
}
