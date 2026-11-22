import { handle } from "@/lib/connections/http";
import { connectionModels } from "@/lib/connections/service";

type Context = { params: Promise<{ id: string }> };

// GET /api/connections/:id/models -> { models, error }: the models the
// connection's key can use, as the model gateway last listed them.
export async function GET(_request: Request, { params }: Context) {
    const { id } = await params;
    return handle(userId => connectionModels(userId, id));
}
