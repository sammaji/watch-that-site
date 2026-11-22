import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Flap fixture" };

const STOCK: Record<string, string> = {
    a: "Availability: in the warehouse and ready to ship.",
    b: "Availability: temporarily sold out, back soon.",
};

export default function FlapFixture() {
    const variant = getVariant("flap");
    return (
        <Fixture scenario="flap" variant={variant}>
            <h1 style={h1Style}>Oak standing desk</h1>
            <p id="availability" style={pStyle}>
                {STOCK[variant]}
            </p>
            <p style={pStyle}>
                Solid oak top with a steel frame and a lifetime warranty.
            </p>
        </Fixture>
    );
}
