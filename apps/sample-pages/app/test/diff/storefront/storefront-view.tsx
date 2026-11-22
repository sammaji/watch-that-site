import { Fixture, h1Style, h2Style, pStyle } from "../_components/fixture";

/**
 * The Northwind storefront: a hero image, plan prices and a testimonial.
 * Three kinds of content a Watch Plan should treat differently: how the hero
 * looks matters, the words of the prices matter, and the testimonial is
 * Noise. The fixed fixture (`page.tsx`) and the live one (`live/page.tsx`)
 * both render it; they differ only in where the content comes from.
 */

export const QUOTES = [
    ["Northwind cut our reporting time in half.", "Priya, Operations lead"],
    ["Setup took ten minutes and it has not broken since.", "Marcus, Founder"],
    ["The team finally trusts the numbers.", "Elena, Finance director"],
    ["We replaced three tools with this one.", "Tomasz, Engineering manager"],
] as const;

function svg(body: string) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="912" height="260" viewBox="0 0 912 260">${body}</svg>`,
    )}`;
}

// Two clearly different pictures of the same size.
export const HERO_MOUNTAINS = svg(
    `<rect width="912" height="260" fill="#cfe8ff"/><circle cx="760" cy="70" r="38" fill="#ffd34d"/><polygon points="0,260 220,80 440,260" fill="#3f6fb5"/><polygon points="300,260 560,40 820,260" fill="#2b4f86"/><polygon points="620,260 780,130 912,260" fill="#5d8fd6"/>`,
);
export const HERO_DASHBOARD = svg(
    `<rect width="912" height="260" fill="#1d1f2b"/><rect x="60" y="40" width="320" height="180" rx="10" fill="#2c3042"/><rect x="90" y="150" width="40" height="50" fill="#ff7a59"/><rect x="150" y="110" width="40" height="90" fill="#ff7a59"/><rect x="210" y="80" width="40" height="120" fill="#ff7a59"/><rect x="270" y="130" width="40" height="70" fill="#ff7a59"/><rect x="430" y="40" width="420" height="80" rx="10" fill="#2c3042"/><rect x="430" y="140" width="420" height="80" rx="10" fill="#3a4060"/>`,
);

const cardStyle = {
    flex: 1,
    padding: 16,
    border: "1px solid #d0d7de",
    borderRadius: 8,
} as const;

export function StorefrontView({
    variant,
    hero,
    prices,
    enterprise = false,
    quote: [quote, who],
}: {
    /** Written to `data-variant` on the page; not shown. */
    variant: string;
    hero: string;
    /** Monthly prices as shown, e.g. "$99". */
    prices: { solo: string; team: string; company: string };
    /** Adds a fourth plan. */
    enterprise?: boolean;
    quote: readonly [string, string];
}) {
    return (
        <Fixture scenario="storefront" variant={variant}>
            <header id="hero">
                <h1 style={h1Style}>Northwind Analytics</h1>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    id="hero-image"
                    src={hero}
                    alt="Product illustration"
                    width={912}
                    height={260}
                    style={{ display: "block", borderRadius: 8 }}
                />
            </header>

            <section id="plans">
                <h2 style={h2Style}>Plans</h2>
                <div style={{ display: "flex", gap: 16 }}>
                    <div id="plan-solo" style={cardStyle}>
                        <strong>Solo</strong>
                        <p style={pStyle}>{prices.solo} per month</p>
                        <p style={pStyle}>One workspace, daily refresh.</p>
                    </div>
                    <div id="plan-team" style={cardStyle}>
                        <strong>Team</strong>
                        <p style={pStyle}>{prices.team} per month</p>
                        <p style={pStyle}>
                            Ten seats, hourly refresh, sharing.
                        </p>
                    </div>
                    <div id="plan-company" style={cardStyle}>
                        <strong>Company</strong>
                        <p style={pStyle}>{prices.company} per month</p>
                        <p style={pStyle}>
                            Unlimited seats and single sign-on.
                        </p>
                    </div>
                    {enterprise ?
                        <div id="plan-enterprise" style={cardStyle}>
                            <strong>Enterprise</strong>
                            <p style={pStyle}>$999 per month</p>
                            <p style={pStyle}>
                                Dedicated support and audit log.
                            </p>
                        </div>
                    :   null}
                </div>
            </section>

            <section id="testimonials">
                <h2 style={h2Style}>What customers say</h2>
                <blockquote
                    id="testimonial"
                    style={{
                        margin: 0,
                        padding: 16,
                        height: 72,
                        background: "#f6f8fa",
                        borderRadius: 8,
                    }}>
                    <p style={pStyle}>{quote}</p>
                    <cite>{who}</cite>
                </blockquote>
            </section>

            <footer id="footer" style={{ marginTop: 24, color: "#57606a" }}>
                <p style={pStyle}>
                    Northwind Analytics Ltd. Prices exclude sales tax.
                </p>
            </footer>
        </Fixture>
    );
}
