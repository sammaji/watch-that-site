import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ignored fixture" };

// Only the sidebar changes between variants. Every sidebar sentence starts
// with "Sidebar note:" so an ignore_text rule can target it.
const SIDEBAR: Record<string, string> = {
    v1: "Sidebar note: the reading room is open until eight tonight.",
    v2: "Sidebar note: the reading room closes early for cleaning.",
};

export default function IgnoredFixture() {
    const variant = getVariant("ignored");
    return (
        <Fixture
            scenario="ignored"
            variant={variant}
            style={{ display: "flex", gap: 24 }}
        >
            <article style={{ width: 640 }}>
                <h1 style={h1Style}>Library opening hours</h1>
                <p style={pStyle}>
                    The main hall is open from nine to five, Monday to Friday.
                </p>
                <p style={pStyle}>
                    Members can borrow up to six books at a time.
                </p>
            </article>
            <aside
                className="sidebar"
                style={{
                    width: 248,
                    padding: 12,
                    border: "1px solid #d0d7de",
                    borderRadius: 6,
                }}
            >
                <p style={pStyle}>{SIDEBAR[variant]}</p>
            </aside>
        </Fixture>
    );
}
