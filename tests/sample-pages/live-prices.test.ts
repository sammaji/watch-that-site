import { describe, expect, it } from "vitest";
import {
    LIVE_WINDOW_MS,
    livePrices,
    liveWindow,
    nextWindowAt,
} from "../../apps/sample-pages/lib/live-prices";

// A fixed moment, so the test does not depend on when it runs.
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);

describe("live storefront prices", () => {
    it("are the same for every moment inside one 30-second window", () => {
        const start = liveWindow(T0) * LIVE_WINDOW_MS;
        const first = livePrices(start);
        for (const offset of [1, 999, 15_000, 29_999]) {
            expect(livePrices(start + offset)).toEqual(first);
        }
        expect(nextWindowAt(start + 12_345)).toBe(start + LIVE_WINDOW_MS);
    });

    it("change for every plan from each window to the next", () => {
        // Two days of windows, well past the 1,716-window cycle.
        let previous = livePrices(T0);
        for (let i = 1; i <= 5_760; i++) {
            const current = livePrices(T0 + i * LIVE_WINDOW_MS);
            expect(current.solo, `solo, window ${i}`).not.toBe(previous.solo);
            expect(current.team, `team, window ${i}`).not.toBe(previous.team);
            expect(current.company, `company, window ${i}`).not.toBe(
                previous.company,
            );
            previous = current;
        }
    });

    it("depend on the time alone", () => {
        // The values for a known moment never change between runs, processes
        // or machines: there is nothing to remember.
        expect(livePrices(T0)).toEqual(livePrices(T0));
        expect(livePrices(T0)).toMatchInlineSnapshot(`
          {
            "company": 359,
            "solo": 25,
            "team": 169,
          }
        `);
    });

    it("stay inside each plan's range", () => {
        for (let i = 0; i < 2_000; i++) {
            const { solo, team, company } = livePrices(T0 + i * LIVE_WINDOW_MS);
            expect(solo).toBeGreaterThanOrEqual(15);
            expect(solo).toBeLessThanOrEqual(35);
            expect(team).toBeGreaterThanOrEqual(79);
            expect(team).toBeLessThanOrEqual(199);
            expect(company).toBeGreaterThanOrEqual(299);
            expect(company).toBeLessThanOrEqual(519);
        }
    });
});
