import { getScratch, getVariant, setScratch } from "@/lib/diff-state";
import type { Metadata } from "next";
import {
    HERO_DASHBOARD,
    HERO_MOUNTAINS,
    QUOTES,
    StorefrontView,
} from "./storefront-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Northwind storefront fixture" };

/**
 * The storefront with content chosen by a test: v2 raises the Team price, v3
 * swaps the hero image only, v4 is v2 with a fourth plan. The testimonial
 * rotates on every load. `live/` is the same page driven by the clock.
 */
export default function StorefrontFixture() {
    const variant = getVariant("storefront");

    // A different testimonial on every request.
    const turn = (getScratch<number>("storefront-quote") ?? 0) + 1;
    setScratch("storefront-quote", turn);

    return (
        <StorefrontView
            variant={variant}
            hero={variant === "v3" ? HERO_DASHBOARD : HERO_MOUNTAINS}
            prices={{
                solo: "$19",
                team: variant === "v2" || variant === "v4" ? "$129" : "$99",
                company: "$399",
            }}
            enterprise={variant === "v4"}
            quote={QUOTES[turn % QUOTES.length]!}
        />
    );
}
