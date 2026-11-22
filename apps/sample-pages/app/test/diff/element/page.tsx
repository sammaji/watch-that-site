import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Element fixture" };

// v1 → v2 changes only the text outside #watched; v2 → v3 changes the text
// inside it; v4 removes #watched entirely (scope_missing).
const OUTSIDE: Record<string, string> = {
    v1: "Store news: the spring catalogue is out now.",
    v2: "Store news: the summer catalogue is out now.",
    v3: "Store news: the summer catalogue is out now.",
    v4: "Store news: the summer catalogue is out now.",
};

const INSIDE: Record<string, string> = {
    v1: "Delivery takes three working days.",
    v2: "Delivery takes three working days.",
    v3: "Delivery takes five working days.",
};

export default function ElementFixture() {
    const variant = getVariant("element");
    return (
        <Fixture scenario="element" variant={variant}>
            <h1 style={h1Style}>Shipping information</h1>
            <p id="outside" style={pStyle}>
                {OUTSIDE[variant]}
            </p>
            {variant === "v4" ? null : (
                <section
                    id="watched"
                    style={{
                        width: 600,
                        height: 96,
                        padding: 16,
                        border: "2px solid #0969da",
                        borderRadius: 6,
                    }}
                >
                    <h2 style={{ fontSize: 20, margin: "0 0 8px" }}>
                        Delivery times
                    </h2>
                    <p style={{ margin: 0 }}>{INSIDE[variant]}</p>
                </section>
            )}
            <p style={{ ...pStyle, marginTop: 16 }}>
                Returns are free within thirty days.
            </p>
        </Fixture>
    );
}
