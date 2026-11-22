import { handle } from "@/lib/connections/http";
import { isUsagePeriod, readUsage } from "@/lib/usage";

// GET /api/usage?period=24h|7d|30d -> the signed-in account's model usage
// from the gateway's logs, and what is left of the WatchThatSite credit.
export async function GET(request: Request) {
    const period = new URL(request.url).searchParams.get("period") ?? "7d";
    return handle(async userId =>
        readUsage(userId, isUsagePeriod(period) ? period : "7d"),
    );
}
