import { monitorAccess, ownerMessage } from "@/app/actions/guard";
import { agent } from "@/lib/agent";
import { checkSteps } from "@/lib/macro";
import { NextResponse } from "next/server";

/**
 * POST /api/monitors/{id}/macro/test  { steps: MacroStep[] }
 *
 * Replays the steps once in a fresh browser, without a model, and answers
 * with the agent API's TestMacroResponse: how each step went and a screenshot
 * of where the page ended up.
 *
 * A route rather than a server action because a replay can take a minute:
 * server actions run one at a time per tab, so a long one would hold up
 * everything else the page does meanwhile (polling a Run, saving a secret).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string) {
    return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> },
) {
    const { id } = await context.params;
    try {
        const access = await monitorAccess(id);
        if (!access.ok) {
            return fail(
                access.error.startsWith("You are signed out") ? 401 : 404,
                access.error,
            );
        }
        const body = (await request.json().catch(() => null)) as {
            steps?: unknown;
        } | null;
        const checked = checkSteps(body?.steps);
        if (!checked.ok) return fail(400, checked.error);
        const result = await agent.testMacro({
            monitor_id: id,
            steps: checked.steps,
        });
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        return fail(502, ownerMessage(error));
    }
}
