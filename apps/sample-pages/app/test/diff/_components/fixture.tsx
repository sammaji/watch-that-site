import type { CSSProperties, ReactNode } from "react";

/**
 * Fixture is the shared frame of the `/test/diff/*` pages: a fixed 960 px
 * column, system fonts only (no network fonts), and no animation, so
 * screenshots are stable across Runs.
 */
export function Fixture({
    scenario,
    variant,
    children,
    style,
}: {
    scenario: string;
    variant: string;
    children: ReactNode;
    style?: CSSProperties;
}) {
    return (
        <main
            data-fixture={scenario}
            data-variant={variant}
            style={{
                boxSizing: "border-box",
                width: 960,
                margin: "0 auto",
                padding: 24,
                background: "#ffffff",
                color: "#111111",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 16,
                lineHeight: "24px",
                ...style,
            }}
        >
            {children}
        </main>
    );
}

export const h1Style: CSSProperties = {
    fontSize: 32,
    lineHeight: "40px",
    fontWeight: 700,
    margin: "0 0 16px",
};

export const h2Style: CSSProperties = {
    fontSize: 22,
    lineHeight: "30px",
    fontWeight: 700,
    margin: "24px 0 12px",
};

export const pStyle: CSSProperties = { margin: "0 0 12px" };
