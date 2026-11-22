import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "A/B fixture" };

const HEADLINES: Record<string, string> = {
    a: "Know the moment a page changes",
    b: "Stop refreshing pages to spot changes",
};

export default function AbFixture() {
    const variant = getVariant("ab");
    return (
        <Fixture scenario="ab" variant={variant}>
            <section id="hero">
                <h1 id="headline" style={h1Style}>
                    {HEADLINES[variant]}
                </h1>
            </section>
            <p style={pStyle}>
                WatchThatSite checks the pages you care about and tells you
                what changed.
            </p>
            <p style={pStyle}>No credit card is needed to get started.</p>
        </Fixture>
    );
}
