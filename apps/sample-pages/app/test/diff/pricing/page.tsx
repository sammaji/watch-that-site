import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, h2Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pricing fixture" };

// The drift variants (e1–e5) keep v1's prices and each insert exactly one more
// word into the intro paragraph than the variant before.
const INTRO: Record<string, string> = {
    v1: "Pick a plan that fits your team.",
    v2: "Pick a plan that fits your team.",
    v3: "Pick a plan that fits your team.",
    e1: "Pick a plan that fits your growing team.",
    e2: "Pick a plan that fits your growing team quickly.",
    e3: "Pick a simple plan that fits your growing team quickly.",
    e4: "Pick a simple plan that fits your whole growing team quickly.",
    e5: "Pick a simple monthly plan that fits your whole growing team quickly.",
};

const rowStyle = {
    margin: "0 0 8px",
    padding: "12px 16px",
    height: 48,
    border: "1px solid #d0d7de",
    borderRadius: 6,
    listStyle: "none",
} as const;

export default function PricingFixture() {
    const variant = getVariant("pricing");
    const proPrice = variant === "v2" || variant === "v3" ? "$59" : "$49";

    return (
        <Fixture scenario="pricing" variant={variant}>
            <h1 style={h1Style}>Acme Monitor pricing</h1>
            <p id="pricing-intro" style={pStyle}>
                {INTRO[variant]}
            </p>
            <h2 style={h2Style}>Plans</h2>
            <ul id="plans" style={{ margin: 0, padding: 0 }}>
                <li id="plan-starter" style={rowStyle}>
                    <strong>Starter</strong> $19 per month. Email alerts for a
                    handful of pages.
                </li>
                <li id="plan-pro" style={rowStyle}>
                    <strong>Pro</strong> {proPrice} per month. Unlimited pages
                    and team sharing.
                </li>
                <li id="plan-business" style={rowStyle}>
                    <strong>Business</strong> $99 per month. Audit log and
                    priority checks.
                </li>
                {variant === "v3" ?
                    <li id="plan-enterprise" style={rowStyle}>
                        <strong>Enterprise</strong> $299 per month. Single
                        sign-on and a dedicated contact.
                    </li>
                :   null}
            </ul>
            <p style={{ ...pStyle, marginTop: 24, color: "#57606a" }}>
                Prices exclude sales tax. Cancel whenever you like.
            </p>
        </Fixture>
    );
}
