import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style, h2Style, pStyle } from "../_components/fixture";
import { LazySection } from "./lazy-section";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lazy fixture" };

const LAZY_TEXT: Record<string, string> = {
    v1: "Late arrivals: the autumn collection ships in October.",
    v2: "Late arrivals: the autumn collection ships in November.",
};

// Twenty 150 px chapters push the lazy section to about y = 3,200.
const CHAPTERS = Array.from({ length: 20 }, (_, i) => i + 1);

export default function LazyFixture() {
    const variant = getVariant("lazy");
    return (
        <Fixture scenario="lazy" variant={variant}>
            <h1 style={h1Style}>Collection archive</h1>
            {CHAPTERS.map(n => (
                <section
                    key={n}
                    style={{
                        height: 150,
                        margin: 0,
                        padding: "8px 0",
                        borderBottom: "1px solid #d0d7de",
                    }}
                >
                    <h2 style={{ ...h2Style, margin: "8px 0" }}>
                        Chapter {n}
                    </h2>
                    <p style={pStyle}>
                        Archive chapter {n} lists the pieces from season{" "}
                        {n} of the collection.
                    </p>
                </section>
            ))}
            <h2 style={h2Style}>Coming soon</h2>
            <LazySection text={LAZY_TEXT[variant]} />
            <div style={{ height: 200 }} />
        </Fixture>
    );
}
