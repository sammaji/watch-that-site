import { getScratch, getVariant, setScratch } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Volatile fixture" };

// The banner rotates between product names chosen by Date.now(). None of this
// text matches a volatile-token pattern, so masking cannot hide it; only the
// learning pass (an ignore_block suggestion) can.
const BANNER_PRODUCTS = [
    "Aurora Headphones",
    "Borealis Kettle",
    "Cascade Backpack",
    "Dunmore Desk Lamp",
    "Everly Rain Jacket",
    "Fjord Water Bottle",
    "Glenrock Hiking Boots",
];

// Anchor for the "N minutes ago" line: 2026-01-01T00:00:00Z.
const POSTED_ANCHOR_MS = Date.UTC(2026, 0, 1);

function pickBanner(now: number) {
    // Chosen by the clock, but never the same product twice in a row, so two
    // Captures taken a few seconds apart always see different banners.
    let index = Math.floor(now / 1000) % BANNER_PRODUCTS.length;
    const last = getScratch<number>("volatile.banner");
    if (last === index) index = (index + 1) % BANNER_PRODUCTS.length;
    setScratch("volatile.banner", index);
    return BANNER_PRODUCTS[index];
}

/** volatileValues derives every time-dependent value from one clock read. */
function volatileValues() {
    const now = Date.now();
    return {
        clock: new Date(now).toISOString().slice(11, 19),
        minutesAgo: 2 + (Math.floor((now - POSTED_ANCHOR_MS) / 60_000) % 50),
        views: (1000 + (Math.floor(now / 1000) % 9000)).toLocaleString("en-US"),
        assetVersion: Math.floor(now / 1000),
        banner: pickBanner(now),
    };
}

export default function VolatileFixture() {
    const variant = getVariant("volatile");
    const { clock, minutesAgo, views, assetVersion, banner } = volatileValues();

    return (
        <Fixture scenario="volatile" variant={variant}>
            <div
                id="promo-banner"
                style={{
                    height: 48,
                    margin: "0 0 16px",
                    padding: "12px 16px",
                    background: "#fff8c5",
                    border: "1px solid #d4a72c",
                    borderRadius: 6,
                }}
            >
                {`Featured product: ${banner}`}
            </div>
            <h1 style={h1Style}>Release notes</h1>
            <p id="clock" style={pStyle}>
                {`Updated at ${clock} UTC`}
            </p>
            <p id="posted" style={pStyle}>
                {`Posted ${minutesAgo} minutes ago`}
            </p>
            <p id="views" style={pStyle}>
                {`${views} views`}
            </p>
            <p id="asset" style={pStyle}>
                Stylesheet:{" "}
                <a href={`/test/assets/proxy-fixture.css?ver=${assetVersion}`}>
                    {`/static/app.css?ver=${assetVersion}`}
                </a>
            </p>
            <p style={pStyle}>
                This release improves the export dialog and fixes the broken
                search shortcut on the settings page.
            </p>
            <p style={pStyle}>
                Thanks to everyone who reported problems with the export
                dialog.
            </p>
        </Fixture>
    );
}
