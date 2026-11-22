import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../_components/fixture";
import { CounterCanvas } from "./counter-canvas";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Animated fixture" };

const SPINNER_CSS = `
@keyframes wts-fixture-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes wts-fixture-pulse { 0%, 100% { background: #ddf4ff; } 50% { background: #0969da; } }
#spinner { animation: wts-fixture-spin 1.2s linear infinite; }
#pulse { animation: wts-fixture-pulse 0.8s ease-in-out infinite; }
`;

export default function AnimatedFixture() {
    const variant = getVariant("animated");
    return (
        <Fixture scenario="animated" variant={variant}>
            <style>{SPINNER_CSS}</style>
            <h1 style={h1Style}>Live dashboard</h1>
            <p style={pStyle}>
                The counter below is drawn on a canvas and never stops.
            </p>
            <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <div
                    id="spinner"
                    style={{
                        width: 64,
                        height: 64,
                        border: "8px solid #d0d7de",
                        borderTopColor: "#cf222e",
                        borderRadius: "50%",
                    }}
                />
                <div
                    id="pulse"
                    style={{ width: 120, height: 64, borderRadius: 6 }}
                />
                <CounterCanvas />
            </div>
            <p style={{ ...pStyle, marginTop: 16 }}>
                Figures refresh continuously while the page is open.
            </p>
        </Fixture>
    );
}
