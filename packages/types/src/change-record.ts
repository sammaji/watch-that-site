/**
 * The Change Record: the one versioned object the web viewer, every
 * notification and the webhook payload read. It holds the agent's answer
 * (summary, items, what it ignored) and the evidence under it (the text diff
 * and the changed screenshot regions).
 *
 * Mirrors services/scheduler/internal/changerecord/record.go and the evidence
 * types in services/scheduler/internal/diff/evidence.go. The golden fixture
 * services/scheduler/internal/changerecord/testdata/change_record.json is
 * decoded strictly by both test suites, so drift fails CI on both sides.
 */

import type { Rect } from "./monitor-config";
import type { WatchHow } from "./watch-plan";

export const CHANGE_RECORD_VERSION = 2;

export type ChangeStatus = "change" | "noise" | "pending";

export type RunVerdict = "baseline" | "none" | ChangeStatus;

/** Why a recorded difference did not alert. */
export type SuppressionReason =
    /** The Agent judged the difference not relevant to the Instructions. */
    | "not_relevant"
    /** Gone by the confirm Run. */
    | "did_not_persist"
    /** Only Sections the Watch Plan ignores (or watches for looks only) differed. */
    | "ignored_section";

export type WhyKind = "agent" | "suppressed" | "persistence" | "note";

/** One plain-language line about how the verdict was reached. */
export interface Why {
    kind: WhyKind;
    /** A stable code: not_relevant, did_not_persist, persistence, agent_unavailable, shift_only. */
    reason?: string;
    detail: string;
}

export interface MonitorRef {
    id: string;
    name: string;
    url: string;
    /** The Monitor's instructions when the Change was recorded. */
    instructions: string;
}

export interface RunRef {
    run_id: string;
    at: string;
    /** Object key of the Capture's screenshot, or "". */
    screenshot: string;
    /** Object key of the Capture's blocks.json.gz. */
    blocks: string;
}

export interface Magnitude {
    words_added: number;
    words_removed: number;
    blocks_changed: number;
    moves: number;
    change_ratio: number;
    net_added: number;
    net_removed: number;
    area_ratio: number;
}

export type OpKind = "add" | "remove" | "modify" | "move" | "ignored";

export interface WordOp {
    op: "=" | "-" | "+";
    text: string;
    mask?: string;
}

export interface TextOp {
    op: OpKind;
    block_id?: string;
    from_block_id?: string;
    path: string;
    tag?: string;
    rect?: Rect;
    from_rect?: Rect;
    text?: string;
    old_text?: string;
    tokens?: WordOp[];
    whole?: boolean;
    from: number;
    to: number;
    context_before?: string[];
    context_after?: string[];
    masked?: string[];
    /** Id of the Watch Plan Section the block lies in; absent outside every Section. */
    section?: string;
}

export interface TextSection {
    ops: TextOp[];
    ignored_count: number;
    masked: string[];
}

export type RegionKind =
    "changed" | "inserted_band" | "removed_band" | "extra_width";

/**
 * One box of visual change. `box` is in "after" screenshot coordinates,
 * except for an area that exists on the before side only (a removed band, or
 * the extra width of a wider before screenshot), which is reported where it
 * was on the before screenshot.
 */
export interface Region {
    box: Rect;
    kind: RegionKind;
    pixels: number;
    blocks?: string[];
    /**
     * Where the same area lies on the before screenshot, which differs from
     * `box` whenever content above it moved. Absent when the area exists on
     * the after side only.
     */
    from_box?: Rect;
    /** Id of the Watch Plan Section the region was found in; absent outside every Section. */
    section?: string;
}

export interface Shift {
    from_y: number;
    dy: number;
}

export interface VisualSection {
    regions: Region[];
    shift: Shift | null;
    area_ratio: number;
    size_before: [number, number];
    size_after: [number, number];
    /** Object keys, "" when not rendered. */
    diff_image: string;
    crop: string;
}

export type ItemKind = "text" | "visual";

/**
 * One thing the agent reports as changed. Every item points at the evidence
 * that shows it: indexes into `text.ops` and `visual.regions`. An item with
 * no valid evidence is dropped before the record is stored.
 */
export interface ChangeItem {
    /** A short label: "Enterprise price raised". */
    title: string;
    /** What it said or looked like before; "" when it is new. */
    before: string;
    /** What it says or looks like now; "" when it was removed. */
    after: string;
    kind: ItemKind;
    /** The part of the instructions this matches, in a few words. */
    matches: string;
    ops: number[];
    regions: number[];
    /** Where it is on each screenshot, in screenshot pixels. */
    rect_before: Rect | null;
    rect_after: Rect | null;
}

/** A difference the agent saw and left out, and why. */
export interface IgnoredItem {
    note: string;
    reason: string;
}

export type Importance = "high" | "medium" | "low";

/** How the agent reached its answer. */
export interface AgentVerdict {
    /** False: the difference does not match the Monitor's instructions. */
    relevant: boolean;
    importance: Importance;
    model: string;
    /** True when the model could not be reached; the Change is then sent as is. */
    unavailable: boolean;
    error: string;
    input_tokens: number;
    output_tokens: number;
    /** Model turns taken. */
    steps: number;
}

/**
 * One Section of the Watch Plan the Change was recorded under. Text ops and
 * regions carry Section ids; this gives them their names.
 */
export interface RecordSection {
    id: string;
    name: string;
    how: WatchHow;
}

export interface Cumulative {
    from: RunRef;
    text: TextSection | null;
    magnitude: Magnitude;
}

export interface ChangeRecord {
    version: number;
    id: string;
    monitor: MonitorRef;
    from: RunRef;
    to: RunRef;
    status: ChangeStatus;
    /** The agent's one-sentence answer. */
    summary: string;
    items: ChangeItem[];
    ignored: IgnoredItem[];
    why: Why[];
    suppressed_by: string[];
    magnitude: Magnitude;
    text: TextSection | null;
    visual: VisualSection | null;
    agent: AgentVerdict | null;
    /** The Watch Plan's Sections; empty when the Monitor had no plan. */
    sections?: RecordSection[];
    cumulative: Cumulative | null;
    created_at: string;
}

/** Text ops that can trigger a Change (everything but ignored). */
export function countedOps(section: TextSection | null | undefined): TextOp[] {
    return section?.ops.filter(op => op.op !== "ignored") ?? [];
}

/** One stored block of a Capture (blocks.json.gz). */
export interface CaptureBlock {
    id: string;
    path: string;
    tag: string;
    text: string;
    rect: Rect;
}

export interface StoredBlocks {
    version: number;
    blocks: CaptureBlock[];
    truncated: boolean;
    masks?: Rect[];
}
