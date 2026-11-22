import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, h2Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shift fixture" };

// Fifteen distinct sections make the page about 3,000 px tall, so the 48 px
// promo bar is under 2 % of the screenshot while the large CTA button
// (640 x 96) is over 1 % of it.
const TOPICS = [
    ["Fast checks", "Every page is checked from a clean browser so cached content never hides a change."],
    ["Readable alerts", "Alerts show the words that changed with a line of context on each side."],
    ["Quiet by default", "Clocks, counters and rotating banners are recognised and left out of alerts."],
    ["Team sharing", "Invite colleagues and route alerts for each page to the right channel."],
    ["History", "Every capture is kept so you can compare any two points in time."],
    ["Element picker", "Point at the part of the page you care about and ignore the rest."],
    ["Price tracking", "Number rules fire only when a price rises or falls past your limit."],
    ["Keyword rules", "Hear about a page only when a word you chose appears or disappears."],
    ["Visual checks", "Screenshots are aligned before comparing, so a new banner is one change."],
    ["Digests", "Collect changes into one hourly or daily message instead of many."],
    ["Webhooks", "Send every change as signed JSON to your own systems."],
    ["Snooze", "Pause alerts for a noisy page without losing its history."],
    ["Data feeds", "Watch JSON endpoints and see exactly which fields changed."],
    ["Learning pass", "New monitors learn which parts of a page change on their own."],
    ["Privacy", "Captures are private to your account and expire on schedule."],
] as const;

const SECTIONS = TOPICS.map(([title, body]) => ({ title, body }));

export default function ShiftFixture() {
    const variant = getVariant("shift");
    const showPromo = variant === "v2" || variant === "v3";
    const buttonColor = variant === "v3" ? "#cf222e" : "#1f883d";

    return (
        <>
            {showPromo ?
                <div
                    id="promo-bar"
                    style={{
                        boxSizing: "border-box",
                        height: 48,
                        padding: "12px 24px",
                        background: "#0969da",
                        color: "#ffffff",
                        fontFamily: "Arial, Helvetica, sans-serif",
                        fontSize: 16,
                        lineHeight: "24px",
                        textAlign: "center",
                    }}
                >
                    Spring promotion: two months free on yearly plans
                </div>
            :   null}
            <Fixture scenario="shift" variant={variant}>
                <h1 style={h1Style}>Watch pages without the noise</h1>
                <p style={pStyle}>
                    Set up a monitor in under a minute and hear only about the
                    changes you care about.
                </p>
                <button
                    id="cta-button"
                    type="button"
                    style={{
                        width: 640,
                        height: 96,
                        margin: "8px 0 16px",
                        border: 0,
                        borderRadius: 6,
                        background: buttonColor,
                        color: "#ffffff",
                        fontFamily: "Arial, Helvetica, sans-serif",
                        fontSize: 24,
                        fontWeight: 700,
                    }}
                >
                    Start watching
                </button>
                {SECTIONS.map((section, i) => (
                    <section
                        key={section.title}
                        style={{
                            height: 160,
                            margin: "0 0 16px",
                            padding: 16,
                            border: "1px solid #d0d7de",
                            borderRadius: 6,
                            background: i % 2 === 0 ? "#f6f8fa" : "#ffffff",
                        }}
                    >
                        <h2 style={h2Style}>{section.title}</h2>
                        <p style={pStyle}>{section.body}</p>
                    </section>
                ))}
            </Fixture>
        </>
    );
}
