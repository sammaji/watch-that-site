/**
 * Prices for the live storefront fixture (`/test/diff/storefront/live`): a
 * pure function of the clock. Time is cut into 30-second windows; within a
 * window every request gets the same prices, and each new window brings new
 * ones. Nothing is stored, so a restart or a second server gives the same
 * answer for the same moment.
 *
 * Each plan has a fixed list of prices, put in a scrambled order that is
 * derived from a hash of the plan's name. The window number picks the place
 * in that order. Because a plan's prices are all different, two windows in a
 * row never show the same price, which a plain "hash the window" would do
 * every so often. The three lists have lengths with no common factor (11, 13
 * and 12), so the page as a whole only repeats after 1,716 windows, a little
 * over 14 hours.
 */

export const LIVE_WINDOW_MS = 30_000;

export type LivePlan = "solo" | "team" | "company";

/** First price, step and count of each plan's price list. */
const RANGES: Record<LivePlan, { from: number; step: number; count: number }> =
    {
        solo: { from: 15, step: 2, count: 11 }, // $15 … $35
        team: { from: 79, step: 10, count: 13 }, // $79 … $199
        company: { from: 299, step: 20, count: 12 }, // $299 … $519
    };

/** The window a moment falls in: whole 30-second steps since the epoch. */
export function liveWindow(nowMs: number): number {
    return Math.floor(nowMs / LIVE_WINDOW_MS);
}

/** When the window after `nowMs` starts, in milliseconds since the epoch. */
export function nextWindowAt(nowMs: number): number {
    return (liveWindow(nowMs) + 1) * LIVE_WINDOW_MS;
}

/** FNV-1a, 32 bits: turns a name into a seed. */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** mulberry32: a small generator, good enough to scramble a short list. */
function generator(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A plan's prices in their scrambled order: the same on every call. */
function order(plan: LivePlan): number[] {
    const { from, step, count } = RANGES[plan];
    const prices = Array.from({ length: count }, (_, i) => from + i * step);
    const random = generator(hash(`northwind:${plan}`));
    for (let i = prices.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [prices[i], prices[j]] = [prices[j]!, prices[i]!];
    }
    return prices;
}

const ORDERS: Record<LivePlan, number[]> = {
    solo: order("solo"),
    team: order("team"),
    company: order("company"),
};

/** The monthly price of each plan, in dollars, at `nowMs`. */
export function livePrices(nowMs: number): Record<LivePlan, number> {
    const window = liveWindow(nowMs);
    const at = (plan: LivePlan) => ORDERS[plan][window % ORDERS[plan].length]!;
    return { solo: at("solo"), team: at("team"), company: at("company") };
}
