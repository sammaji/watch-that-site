/**
 * The Watch Plan: how the Agent decided a Monitor's page should be watched.
 *
 * When a Monitor gets its Baseline, the Agent reads the owner's Instructions,
 * looks at the page (its block outline, which is the page's HTML reduced to
 * visible text blocks with their XPaths, and its screenshot) and divides it
 * into Sections, each with the kind of watching it needs:
 *
 *   text    the words matter (prices, terms, listings): the text Comparator
 *   visual  how it looks matters (a hero image, a chart, a map): the visual
 *           Comparator, on that Section only, cropped to the Section on both
 *           Captures so movement elsewhere on the page cannot disturb it
 *   both    words and looks
 *   ignore  the owner does not care (rotating testimonials, ads, footers):
 *           differences here are recorded as ignored and never reach the model
 *
 * Everything outside the Sections is watched as `rest` says, so content that
 * appears later is not silently dropped.
 *
 * Stored in `monitors.watch_plan` (null: no plan yet, the whole page is
 * watched as text and visual). The scheduler writes it after the Agent's plan
 * call and applies it on every Run; the owner can change a Section's `how` in
 * the web app, or ask for a new plan. A new plan is made when the Instructions
 * change, on a re-baseline, and when Sections stop matching the page.
 *
 * Mirrored in services/scheduler/internal/monitor/plan.go.
 */

export type WatchHow = "text" | "visual" | "both" | "ignore";

export interface WatchSection {
    /** A short slug, kept across re-plans when the Section is the same one. */
    id: string;
    /** What a person would call it: "Pricing table". */
    name: string;
    how: WatchHow;
    /** One sentence for the owner: why it is watched this way. */
    why: string;
    /**
     * Block paths (the `path` of a Capture block: an absolute XPath) that root
     * the Section. A block belongs to the Section when its path equals one of
     * these or lies under it. More specific Sections win over broader ones.
     */
    paths: string[];
}

export interface WatchPlan {
    version: 1;
    sections: WatchSection[];
    /** How everything outside the Sections is watched. */
    rest: WatchHow;
    /** One or two sentences for the owner on how the page will be watched. */
    summary: string;
    /**
     * Extra milliseconds the Agent decided to wait before each Capture, for
     * a page that keeps filling in after it loads; saved to the Monitor's
     * extra_wait_ms with the plan. Absent on plans made before it existed.
     */
    wait_ms?: number;
    /** sha256 hex of the Instructions the plan was made for. */
    instructions_hash: string;
    /** The Run whose Capture the Agent looked at. */
    run_id: string;
    /** The model that made it; "" when a person edited it last. */
    model: string;
    created_at: string;
}

export const WATCH_HOWS: WatchHow[] = ["text", "visual", "both", "ignore"];

/** Most Sections a plan may hold. */
export const WATCH_PLAN_MAX_SECTIONS = 24;

/** Whether `path` equals `root` or lies under it. */
export function pathUnder(path: string, root: string): boolean {
    return (
        path === root ||
        (path.length > root.length &&
            path.startsWith(root) &&
            path[root.length] === "/")
    );
}

/**
 * The Section a block path belongs to: the one with the longest matching
 * root, or null when the block is outside every Section.
 */
export function sectionFor(
    plan: WatchPlan | null | undefined,
    path: string,
): WatchSection | null {
    if (!plan) return null;
    let best: WatchSection | null = null;
    let bestLen = -1;
    for (const section of plan.sections) {
        for (const root of section.paths) {
            if (root.length > bestLen && pathUnder(path, root)) {
                best = section;
                bestLen = root.length;
            }
        }
    }
    return best;
}

/** How a block path is watched under a plan. */
export function howFor(
    plan: WatchPlan | null | undefined,
    path: string,
): WatchHow {
    if (!plan) return "both";
    return sectionFor(plan, path)?.how ?? plan.rest;
}
