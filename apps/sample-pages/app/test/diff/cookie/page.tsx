import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cookie fixture" };

const BODY: Record<string, string[]> = {
    v1: [
        "Our office opens at nine and closes at five on weekdays.",
        "Visitors should sign in at the front desk on arrival.",
    ],
    v2: [
        "Our office opens at eight and closes at six on weekdays.",
        "Visitors should sign in at the front desk on arrival.",
    ],
};

/**
 * CookieBanner mirrors OneTrust's real markup (ids and classes), so the
 * cookie-banner blocklists used by the browser worker hide it. Its text must
 * never appear in a Capture.
 */
function CookieBanner() {
    return (
        <div id="onetrust-consent-sdk">
            <div className="onetrust-pc-dark-filter ot-fade-in" />
            <div
                id="onetrust-banner-sdk"
                className="otFlat optanon-alert-box-wrapper"
                role="region"
                aria-label="Cookie banner"
                style={{
                    position: "fixed",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 1000,
                    height: 120,
                    padding: "16px 24px",
                    background: "#1f2328",
                    color: "#ffffff",
                    fontFamily: "Arial, Helvetica, sans-serif",
                    fontSize: 14,
                    lineHeight: "20px",
                }}
            >
                <div role="dialog" aria-label="Privacy" className="ot-sdk-container">
                    <div id="onetrust-policy">
                        <div id="onetrust-policy-text">
                            Cookie consent: we use cookies to personalise
                            content and analyse our traffic. Accept to continue.
                        </div>
                    </div>
                    <div id="onetrust-button-group-parent">
                        <div id="onetrust-button-group">
                            <button id="onetrust-pc-btn-handler" type="button">
                                Cookie Settings
                            </button>{" "}
                            <button id="onetrust-reject-all-handler" type="button">
                                Reject All
                            </button>{" "}
                            <button id="onetrust-accept-btn-handler" type="button">
                                Accept All Cookies
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function CookieFixture() {
    const variant = getVariant("cookie");
    return (
        <>
            <Fixture scenario="cookie" variant={variant}>
                <h1 style={h1Style}>Visiting our office</h1>
                {BODY[variant].map(line => (
                    <p key={line} style={pStyle}>
                        {line}
                    </p>
                ))}
            </Fixture>
            <CookieBanner />
        </>
    );
}
