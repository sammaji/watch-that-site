import { livePrices, liveWindow } from "@/lib/live-prices";
import type { Metadata } from "next";
import { HERO_MOUNTAINS, QUOTES, StorefrontView } from "../storefront-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Northwind storefront, live" };

/**
 * The storefront driven by the clock, for watching a Monitor work over time
 * without flipping anything by hand. Every 30 seconds each plan gets a new
 * price and the testimonial moves on; within those 30 seconds every load is
 * identical. It keeps no state: what it shows is computed from the current
 * time alone (see `lib/live-prices.ts`).
 */
export default function LiveStorefrontFixture() {
    // The clock is this page's only input. It is a server component rendered
    // once per request (`force-dynamic`), never re-rendered in a browser, so
    // the rule against reading the time during render does not apply.
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    const window = liveWindow(now);
    const prices = livePrices(now);

    return (
        <StorefrontView
            variant={`live-${window}`}
            hero={HERO_MOUNTAINS}
            prices={{
                solo: `$${prices.solo}`,
                team: `$${prices.team}`,
                company: `$${prices.company}`,
            }}
            quote={QUOTES[window % QUOTES.length]!}
        />
    );
}
