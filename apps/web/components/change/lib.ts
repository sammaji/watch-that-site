import {
    countedOps,
    sectionFor,
    type CaptureBlock,
    type ChangeItem,
    type ChangeRecord,
    type RecordSection,
    type Rect,
    type TextOp,
    type WatchPlan,
} from "@watchthatsite/types";

/** Plain names for the kinds of text that change on their own. */
const SELF_CHANGING_COPY: Record<string, string> = {
    reltime: "a relative time",
    clock: "a clock time",
    today: "today's date",
    counter: "a counter",
    nonce: "a random token",
    copyright: "a copyright year",
};

export function selfChangingCopy(kind: string): string {
    return SELF_CHANGING_COPY[kind] ?? kind;
}

export const OP_LABEL: Record<TextOp["op"], string> = {
    add: "Added",
    remove: "Removed",
    modify: "Changed",
    move: "Moved",
    ignored: "Ignored",
};

/** Word-level highlight classes (GitHub-style, with dark variants). */
export const ADDED_CLASS =
    "rounded-sm bg-[#e6ffec] px-0.5 text-[#1a7f37] dark:bg-[#2ea043]/25 dark:text-[#56d364]";
export const REMOVED_CLASS =
    "rounded-sm bg-[#ffebe9] px-0.5 text-[#cf222e] line-through dark:bg-[#f85149]/20 dark:text-[#ff7b72]";

/** The same colours for a whole Before or After panel. */
export const BEFORE_PANEL_CLASS =
    "border-[#cf222e]/25 bg-[#ffebe9]/40 dark:border-[#f85149]/30 dark:bg-[#f85149]/10";
export const AFTER_PANEL_CLASS =
    "border-[#1a7f37]/25 bg-[#e6ffec]/40 dark:border-[#2ea043]/30 dark:bg-[#2ea043]/10";
export const BEFORE_LABEL_CLASS = "text-[#cf222e] dark:text-[#ff7b72]";
export const AFTER_LABEL_CLASS = "text-[#1a7f37] dark:text-[#56d364]";

export function formatPercent(ratio: number): string {
    const pct = ratio * 100;
    if (pct === 0) return "0 %";
    if (pct < 0.1) return "<0.1 %";
    return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)} %`;
}

export function formatNumber(n: number | undefined): string {
    if (n === undefined || Number.isNaN(n)) return "–";
    return Number.isInteger(n) ?
            n.toLocaleString("en-US")
        :   String(+n.toFixed(4));
}

/**
 * The Sections a Change Record was recorded under. Records made before the
 * Monitor had a Watch Plan (and older fixtures) carry none.
 */
export function recordSections(record: ChangeRecord): RecordSection[] {
    return Array.isArray(record.sections) ? record.sections : [];
}

/**
 * The id of the Section an op lies in, "" outside every Section. A record
 * that carries Sections has the answer on the op itself; for one that does
 * not, it is worked out from the Monitor's current plan.
 */
export function opSection(
    op: TextOp,
    record: ChangeRecord,
    plan: WatchPlan | null,
): string {
    if (recordSections(record).length > 0) return op.section ?? "";
    return op.section ?? sectionFor(plan, op.path)?.id ?? "";
}

/** The id of the Section an Item's evidence lies in, "" when none or mixed. */
export function itemSection(
    item: ChangeItem,
    record: ChangeRecord,
    plan: WatchPlan | null,
): string {
    const ids = new Set<string>();
    for (const index of item.ops) {
        const op = record.text?.ops[index];
        if (op) ids.add(opSection(op, record, plan));
    }
    for (const index of item.regions) {
        const region = record.visual?.regions[index];
        if (region) ids.add(region.section ?? "");
    }
    return ids.size === 1 ? [...ids][0]! : "";
}

/**
 * The one Section this whole Change sits in, or "" when its evidence is
 * spread over several Sections or lies outside all of them.
 */
export function changeSection(
    record: ChangeRecord,
    plan: WatchPlan | null,
): string {
    const ids = new Set<string>();
    if (record.items.length > 0) {
        for (const item of record.items) {
            ids.add(itemSection(item, record, plan));
        }
    } else {
        for (const op of countedOps(record.text)) {
            ids.add(opSection(op, record, plan));
        }
        for (const region of record.visual?.regions ?? []) {
            ids.add(region.section ?? "");
        }
    }
    return ids.size === 1 ? [...ids][0]! : "";
}

/** What a Section is called: the record's name for it, else the plan's. */
export function sectionName(
    id: string,
    record: ChangeRecord | null,
    plan: WatchPlan | null,
): string {
    return (
        (record ? recordSections(record) : []).find(s => s.id === id)?.name ??
        plan?.sections.find(s => s.id === id)?.name ??
        ""
    );
}

/**
 * Where each Section is on a Capture: the union of the rectangles of the
 * blocks under its paths. Sections with no visible block are left out.
 */
export function sectionRects(
    plan: WatchPlan | null | undefined,
    blocks: CaptureBlock[] | null | undefined,
): Map<string, Rect> {
    const out = new Map<string, Rect>();
    if (!plan || !blocks) return out;
    for (const block of blocks) {
        const [x, y, w, h] = block.rect;
        if (!(w > 0 && h > 0)) continue;
        const section = sectionFor(plan, block.path);
        if (!section) continue;
        const current = out.get(section.id);
        if (!current) {
            out.set(section.id, [x, y, w, h]);
            continue;
        }
        const left = Math.min(current[0], x);
        const top = Math.min(current[1], y);
        const right = Math.max(current[0] + current[2], x + w);
        const bottom = Math.max(current[1] + current[3], y + h);
        out.set(section.id, [left, top, right - left, bottom - top]);
    }
    return out;
}

/**
 * The sentence "Ignore changes like this" starts from, built from what the
 * Change is about. The owner edits it before it is added to the Instructions.
 */
export function ignoreSentence(
    record: ChangeRecord | null,
    plan: WatchPlan | null,
    fallbackSummary: string,
): string {
    if (record) {
        const section = sectionName(changeSection(record, plan), record, plan);
        if (section) return `Ignore changes to the ${section} section.`;
        const titles = record.items
            .map(item => item.title.trim())
            .filter(Boolean)
            .slice(0, 2);
        if (titles.length === 1) return `Ignore changes like “${titles[0]}”.`;
        if (titles.length === 2) {
            return `Ignore changes like “${titles[0]}” and “${titles[1]}”.`;
        }
    }
    const summary = (record?.summary || fallbackSummary).trim();
    return summary ?
            `Ignore changes like this one: “${summary.replace(/[.\s]+$/, "")}”.`
        :   "Ignore changes like this one.";
}

/** The Instructions with `sentence` added at the end, on its own line. */
export function appendInstruction(
    instructions: string,
    sentence: string,
): string {
    const base = instructions.trim();
    const added = sentence.trim();
    if (!added) return base;
    return base ? `${base}\n${added}` : added;
}
