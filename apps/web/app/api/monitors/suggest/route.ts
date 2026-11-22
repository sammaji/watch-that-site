import { ownerMessage } from "@/app/actions/guard";
import { agent } from "@/lib/agent";
import { handle, readJson } from "@/lib/connections/http";
import { ConnectionError } from "@/lib/connections/service";

/**
 * POST /api/monitors/suggest  { url }
 *
 * For the Monitor form: opens the URL in the worker's browser and has the
 * account's utility model propose a few Instructions that fit the page. A route rather than a server action because it takes several seconds
 * and server actions run one at a time per tab.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
    const body = (await readJson(request)) as { url?: unknown } | null;
    return handle(async userId => {
        const url = typeof body?.url === "string" ? body.url.trim() : "";
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error();
            }
        } catch {
            throw new ConnectionError(400, "Enter an http or https URL.");
        }
        try {
            return await agent.suggest({ user_id: userId, url });
        } catch (error) {
            throw new ConnectionError(502, ownerMessage(error));
        }
    });
}
