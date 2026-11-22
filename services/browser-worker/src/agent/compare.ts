import {
    DEFAULT_INSTRUCTIONS,
    sectionFor,
    type CaptureBlock,
    type CompareItem,
    type CompareRequest,
    type CompareResponse,
    type IgnoredItem,
    type Importance,
    type Rect,
    type TextOp,
    type WatchHow,
    type WatchSection,
} from "@watchthatsite/types";
import { compareLimits } from "../config/constants.js";
import { Trace } from "../store/trace.js";
import { loadBlocks, sectionRect } from "./blocks.js";
import { boxText, StoredImage } from "./images.js";
import {
    adapterOf,
    AgentJobError,
    stopMessage,
    traceTools,
    type AgentDeps,
} from "./job.js";
import { runAgent, type AgentTool, type ToolOutcome } from "./loop.js";
import { clip, PageData } from "./page-data.js";
import { ELEMENT_REFERENCES } from "./references.js";
import { text, type ContentPart } from "./types.js";

/**
 * The compare job: the scheduler found a difference between two Captures;
 * the Agent reads the owner's Instructions and the evidence and answers
 * whether it is a Change the owner asked about.
 */

/** Characters of rendered ops in the first message; the rest is paged with `read_diff`. */
const firstDiffChars = 14_000;
const opChars = 420;
/** Images attached to the first message. Each region takes two. */
const firstImageBudget = 16;
/** Context shown around a region, so the model sees what it belongs to. */
const regionPad = 32;
const sectionPad = 12;

const howWords: Record<WatchHow, string> = {
    text: "text (the words matter)",
    visual: "visual (the look matters)",
    both: "text and visual (words and look both matter)",
    ignore: "ignored",
};

/** Evidence of one Section, or of the page outside every Section. */
export type EvidenceGroup = {
    /** Section id; "" for the rest of the page. */
    id: string;
    name: string;
    how: WatchHow;
    why: string;
    section: WatchSection | null;
    ops: number[];
    regions: number[];
};

const citable = (op: TextOp) => op.op !== "ignored";

/** The text ops and regions of a request, grouped by Watch Plan Section. */
export function groupEvidence(req: CompareRequest): EvidenceGroup[] {
    const plan = req.plan;
    const ops = req.text?.ops ?? [];
    if (!plan) {
        return [
            {
                id: "",
                name: "Whole page",
                how: "both",
                why: "There is no Watch Plan yet, so the whole page is watched for words and look.",
                section: null,
                ops: ops.flatMap((op, i) => (citable(op) ? [i] : [])),
                regions: req.regions.map((_, i) => i),
            },
        ];
    }
    const groups = new Map<string, EvidenceGroup>();
    for (const section of plan.sections) {
        groups.set(section.id, {
            id: section.id,
            name: section.name,
            how: section.how,
            why: section.why,
            section,
            ops: [],
            regions: [],
        });
    }
    const rest: EvidenceGroup = {
        id: "",
        name: "Rest of the page",
        how: plan.rest,
        why: "Outside every Section of the Watch Plan.",
        section: null,
        ops: [],
        regions: [],
    };
    ops.forEach((op, i) => {
        if (!citable(op)) return;
        const id =
            (op as { section?: string }).section ??
            sectionFor(plan, op.path)?.id ??
            "";
        (groups.get(id) ?? rest).ops.push(i);
    });
    req.regions.forEach((region, i) => {
        (groups.get(region.section) ?? rest).regions.push(i);
    });
    return [...groups.values(), rest].filter(
        g => g.ops.length > 0 || g.regions.length > 0,
    );
}

/** Word-level changes of a modified block: `…went from [-$99-] {+$129+} a month…`. */
function renderTokens(op: TextOp): string {
    const tokens = op.tokens ?? [];
    const out: string[] = [];
    let run: string[] = [];
    const flush = (last: boolean) => {
        if (run.length === 0) return;
        // Long unchanged stretches are noise around the change itself.
        if (run.length > 16) {
            const head = out.length === 0 ? [] : run.slice(0, 7);
            const tail = last ? [] : run.slice(-7);
            out.push([...head, "…", ...tail].join(" "));
        } else {
            out.push(run.join(" "));
        }
        run = [];
    };
    for (const token of tokens) {
        const value = token.text.trim();
        if (value === "") continue;
        if (token.op === "=") {
            run.push(...value.split(/\s+/));
            continue;
        }
        flush(false);
        out.push(token.op === "-" ? `[-${value}-]` : `{+${value}+}`);
    }
    flush(true);
    return out.join(" ");
}

/** One op as one or two lines: what happened, and a line of context. */
export function renderOp(index: number, op: TextOp): string {
    const tag = op.tag ? ` <${op.tag}>` : "";
    let line: string;
    switch (op.op) {
        case "add":
            line = `op ${index} · added${tag}: "${clip(op.text ?? "", opChars)}"`;
            break;
        case "remove":
            line = `op ${index} · removed${tag}: "${clip(op.old_text ?? op.text ?? "", opChars)}"`;
            break;
        case "move":
            line = `op ${index} · moved${tag}: "${clip(op.text ?? op.old_text ?? "", opChars)}"`;
            break;
        case "modify": {
            const words = renderTokens(op);
            line =
                words ?
                    `op ${index} · changed${tag}: "${clip(words, opChars)}"  ([-removed-] {+added+})`
                :   `op ${index} · changed${tag}: was "${clip(op.old_text ?? "", opChars / 2)}", now "${clip(op.text ?? "", opChars / 2)}"`;
            break;
        }
        default:
            line = `op ${index} · ${op.op}${tag}: "${clip(op.text ?? op.old_text ?? "", opChars)}"`;
    }
    const before = op.context_before?.at(-1);
    const after = op.context_after?.[0];
    const context = [
        before ? `after "${clip(before, 90)}"` : "",
        after ? `before "${clip(after, 90)}"` : "",
    ]
        .filter(Boolean)
        .join(", ");
    return context ? `${line}\n    (${context})` : line;
}

export type RenderedEvidence = {
    text: string;
    /** Indexes of ops that did not fit and must be paged with `read_diff`. */
    omittedOps: number[];
};

/**
 * The evidence as text, Section by Section, within `budget` characters of
 * op lines. Every region is listed (they are short); ops that do not fit
 * are counted, and the model pages through them with `read_diff`.
 */
export function renderEvidence(
    req: CompareRequest,
    groups: EvidenceGroup[],
    budget = firstDiffChars,
): RenderedEvidence {
    const ops = req.text?.ops ?? [];
    const lines: string[] = [];
    const omittedOps: number[] = [];
    let used = 0;
    for (const group of groups) {
        lines.push(
            `## ${group.section ? `Section "${group.name}"` : group.name}: watched as ${howWords[group.how]}. ${group.why}`,
        );
        if (group.ops.length > 0) {
            const hidden: number[] = [];
            for (const index of group.ops) {
                const line = renderOp(index, ops[index]!);
                if (used + line.length > budget) {
                    hidden.push(index);
                    continue;
                }
                used += line.length;
                lines.push(line);
            }
            if (hidden.length > 0) {
                omittedOps.push(...hidden);
                lines.push(
                    `… and ${hidden.length} more text ops in this part (op ${hidden[0]} to op ${hidden.at(-1)}) not shown here. Read them with read_diff.`,
                );
            }
        }
        for (const index of group.regions) {
            const region = req.regions[index]!;
            lines.push(
                `region ${index} · ${region.kind.replace(/_/g, " ")} at ${boxText(region.box)} (${region.pixels.toLocaleString("en-US")} pixels differ)`,
            );
        }
        lines.push("");
    }
    return { text: lines.join("\n").trimEnd(), omittedOps };
}

/** What `report` must satisfy before the answer is accepted. Returns problems, empty when fine. */
export function checkReport(
    req: CompareRequest,
    input: Record<string, unknown>,
): string[] {
    const problems: string[] = [];
    const ops = req.text?.ops ?? [];
    const items = (input.items ?? []) as Record<string, unknown>[];
    const summary =
        typeof input.summary === "string" ? input.summary.trim() : "";
    if (summary === "") problems.push("summary is empty");
    if (input.relevant === true && items.length === 0) {
        problems.push(
            "relevant is true but there are no items: add an item for each change the owner asked about, or set relevant to false",
        );
    }
    items.forEach((item, i) => {
        const label = `items[${i}]${typeof item.title === "string" && item.title ? ` ("${clip(item.title, 40)}")` : ""}`;
        const citedOps = (item.ops ?? []) as number[];
        const citedRegions = (item.regions ?? []) as number[];
        const badOps = citedOps.filter(
            n =>
                !Number.isInteger(n) ||
                n < 0 ||
                n >= ops.length ||
                !citable(ops[n]!),
        );
        const badRegions = citedRegions.filter(
            n => !Number.isInteger(n) || n < 0 || n >= req.regions.length,
        );
        if (badOps.length > 0) {
            problems.push(
                `${label} cites op ${badOps.join(", ")}, which ${ops.length === 0 ? "does not exist (there are no text ops)" : `is not a text op you can cite (valid: 0 to ${ops.length - 1})`}`,
            );
        }
        if (badRegions.length > 0) {
            problems.push(
                `${label} cites region ${badRegions.join(", ")}, which ${req.regions.length === 0 ? "does not exist (there are no regions)" : `does not exist (valid: 0 to ${req.regions.length - 1})`}`,
            );
        }
        if (
            citedOps.length -
                badOps.length +
                citedRegions.length -
                badRegions.length ===
            0
        ) {
            problems.push(
                `${label} cites no evidence: give the op and/or region indexes that show it`,
            );
        }
    });
    return problems;
}

const lookingAt = {
    type: "string" as const,
    description:
        'A few words on what you are looking at, shown to the owner in the trace: "the pricing table".',
};

const pageParam = {
    type: "string" as const,
    enum: ["before", "after"],
    description:
        "Which Capture: the previous page (before) or the new one (after).",
};

function systemPrompt(pageData: PageData): string {
    return `You work inside WatchThatSite, a service that watches a web page for its owner and tells them when something they care about changes. A Monitor has captured the page again, and this Capture differs from the previous one. Decide whether the difference is something the owner asked to be told about, and say what changed.

What you are given
- The owner's Instructions: what they want to hear about and what to ignore. They alone decide what counts as a Change. ${ELEMENT_REFERENCES}
- The owner's feedback on earlier answers for this Monitor (useful or noise). Read it as examples of what they want.
- The evidence, grouped by Section of the page. The Watch Plan divides the page into Sections and says how each is watched: as text (the words matter), as visual (the look matters), or both. Differences in Sections the owner ignores were already removed. Text differences are numbered ops; changed areas of the screenshot are numbered regions, with before and after images attached.

The evidence is exact; what it needs from you is judgement. Usually the first message holds everything and you can answer in one turn. Use the tools only when looking closer could change your answer: read_diff for ops that did not fit, read_page for the text around a change, view_region and view_screenshot to see part of either screenshot.

Answer by calling report once.
- relevant: true only when at least one difference is something the Instructions ask about.
- summary: one sentence for the owner, specific and plain, such as "The Enterprise plan went from $99 to $129 a month." Name the thing and the values. Do not hedge ("it seems", "may have") and do not mention ops, regions, diffs, Sections or yourself. When nothing relevant changed, say what did change: "Only the rotating testimonial changed."
- items: one per distinct change the owner would want to know about. title is a short label ("Enterprise price raised"). before and after quote the page's own words; use "" for before when the thing is new and for after when it is gone. kind is text or visual. matches names the part of the Instructions it matches, in a few words. Every item must cite the ops and/or regions that show it, by index; an item with no valid evidence is rejected.
- ignored: differences you left out and why, in the owner's terms: "you asked to ignore testimonials", "only the date in the footer changed".
- importance: high when the owner would act on it now (a price, availability, a deadline, terms), medium for an ordinary change they asked about, low for a minor one or when nothing is relevant.

Visual changes
Describe a visual change the way a person would: "the hero photo was replaced by a product screenshot", "the chart's last bar is now higher". For a visual item, before and after describe what was there and what is there now. A pixel difference is not always a real change: anti-aliasing, a sub-pixel shift, a compression artefact, or another frame of an animation look different to a diff and the same to a person. Put those in ignored with the reason, not in items. In a Section watched only as visual, judge the look; in one watched only as text, judge the words.

${pageData.rule}`;
}

type Loaded = {
    before: StoredImage | null;
    after: StoredImage | null;
    blocksBefore: CaptureBlock[] | null;
    blocksAfter: CaptureBlock[] | null;
};

/**
 * Where a region is on each screenshot. The scheduler says where the same
 * area was on the previous page (`from_box`), which differs from `box`
 * whenever content above it moved; an area on one page only has one side.
 */
function regionBoxes(
    req: CompareRequest,
    index: number,
): { before: Rect | null; after: Rect | null } {
    const region = req.regions[index]!;
    if (
        region.kind === "removed_band" ||
        (region.kind === "extra_width" && region.from_box !== null)
    ) {
        return { before: region.from_box ?? region.box, after: null };
    }
    return { before: region.from_box, after: region.box };
}

/**
 * The images of the first message: for a Section watched for its look, the
 * whole Section before and after; then every region before and after, largest
 * first, until the budget is spent.
 */
async function firstImages(
    req: CompareRequest,
    groups: EvidenceGroup[],
    loaded: Loaded,
): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];
    if (!loaded.before && !loaded.after) {
        if (req.regions.length > 0) {
            parts.push(
                text(
                    "The screenshots of these Captures are not stored any more, so no images are attached.",
                ),
            );
        }
        return parts;
    }
    let budget = firstImageBudget;
    const attach = async (
        label: string,
        image: StoredImage | null,
        box: Rect | null,
        pad: number,
    ): Promise<boolean> => {
        if (!image || !box || budget <= 0) return false;
        const crop = await image.crop(box, { pad });
        if (!crop) return false;
        budget--;
        parts.push(
            text(
                `${label}${crop.scale < 1 ? ` (scaled to ${Math.round(crop.scale * 100)}%)` : ""}:`,
            ),
            crop.part,
        );
        return true;
    };

    for (const group of groups) {
        const section = group.section;
        if (!section || group.regions.length === 0) continue;
        if (section.how !== "visual" && section.how !== "both") continue;
        if (budget < 2) break;
        const a =
            loaded.blocksBefore ?
                sectionRect(section, loaded.blocksBefore)
            :   null;
        const b =
            loaded.blocksAfter ?
                sectionRect(section, loaded.blocksAfter)
            :   null;
        await attach(
            `Section "${section.name}" as a whole, before`,
            loaded.before,
            a,
            sectionPad,
        );
        await attach(
            `Section "${section.name}" as a whole, after`,
            loaded.after,
            b,
            sectionPad,
        );
    }

    const order = req.regions
        .map((region, index) => ({ index, pixels: region.pixels }))
        .sort((x, y) => y.pixels - x.pixels);
    const dropped: number[] = [];
    for (const { index } of order) {
        if (budget < 2) {
            dropped.push(index);
            continue;
        }
        const boxes = regionBoxes(req, index);
        const shownBefore = await attach(
            `region ${index}, before`,
            loaded.before,
            boxes.before,
            regionPad,
        );
        const shownAfter = await attach(
            `region ${index}, after`,
            loaded.after,
            boxes.after,
            regionPad,
        );
        if (!shownBefore && !shownAfter) dropped.push(index);
    }
    if (dropped.length > 0) {
        parts.push(
            text(
                `Not attached for lack of room: region ${dropped.sort((x, y) => x - y).join(", ")}. See them with view_region.`,
            ),
        );
    }
    return parts;
}

function firstMessage(
    req: CompareRequest,
    evidence: RenderedEvidence,
    images: ContentPart[],
    pageData: PageData,
): ContentPart[] {
    const instructions = req.monitor.instructions.trim();
    const lines = [
        `Monitor: ${req.monitor.name}`,
        `URL: ${req.monitor.url}`,
        "",
        instructions ?
            `The owner's Instructions:\n"""\n${instructions}\n"""`
        :   `The owner wrote no Instructions, so the default applies:\n"""\n${DEFAULT_INSTRUCTIONS}\n"""`,
    ];
    if (req.feedback.length > 0) {
        lines.push(
            "",
            "The owner's feedback on earlier answers, newest first:",
        );
        for (const f of req.feedback.slice(0, 10)) {
            lines.push(`- marked ${f.feedback}: "${clip(f.summary, 200)}"`);
        }
    }
    const opCount = (req.text?.ops ?? []).filter(citable).length;
    lines.push(
        "",
        `The evidence: ${opCount} text op${opCount === 1 ? "" : "s"} and ${req.regions.length} changed region${req.regions.length === 1 ? "" : "s"}. Screenshots are ${req.size_before[0]}×${req.size_before[1]} (before) and ${req.size_after[0]}×${req.size_after[1]} (after) pixels; boxes are in those pixels.`,
        pageData.wrap(
            "differences",
            evidence.text || "(no differences listed)",
        ),
    );
    return [text(lines.join("\n")), ...images];
}

function compareTools(
    req: CompareRequest,
    loaded: Loaded,
    pageData: PageData,
): AgentTool<CompareAnswer>[] {
    const ops = req.text?.ops ?? [];
    const side = (page: unknown) => (page === "before" ? "previous" : "new");
    const imageOf = (page: unknown) =>
        page === "before" ? loaded.before : loaded.after;
    const fail = (
        message: string,
        title: string | null = null,
    ): ToolOutcome<CompareAnswer> => ({
        content: [text(message)],
        isError: true,
        title,
    });

    const readDiff: AgentTool<CompareAnswer> = {
        def: {
            name: "read_diff",
            description:
                "Lists text ops starting at an index, for ops that did not fit in the first message.",
            inputSchema: {
                type: "object",
                properties: {
                    from: {
                        type: "integer",
                        minimum: 0,
                        description: "Index of the first op to list.",
                    },
                },
                required: ["from"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const from = input.from as number;
            if (from >= ops.length) {
                return fail(
                    `There are only ${ops.length} ops (0 to ${ops.length - 1}).`,
                );
            }
            const lines: string[] = [];
            let used = 0;
            let next = from;
            for (; next < ops.length; next++) {
                const op = ops[next]!;
                if (!citable(op)) continue;
                const section = req.plan ? sectionFor(req.plan, op.path) : null;
                const line = `${renderOp(next, op)}${section ? `  [Section "${section.name}"]` : ""}`;
                if (used + line.length > firstDiffChars && lines.length > 0)
                    break;
                used += line.length;
                lines.push(line);
            }
            if (next < ops.length) {
                lines.push(
                    `… more from op ${next}: call read_diff again with from=${next}.`,
                );
            }
            return {
                content: [text(pageData.wrap("differences", lines.join("\n")))],
                title: "Read more of the text differences",
                detail: { from },
            };
        },
    };

    const readPage: AgentTool<CompareAnswer> = {
        def: {
            name: "read_page",
            description:
                "Reads the text of either page around one place: the block of an op, a block id, or the first block containing some words. Use it to see what a change belongs to.",
            inputSchema: {
                type: "object",
                properties: {
                    page: pageParam,
                    op: {
                        type: "integer",
                        minimum: 0,
                        description: "Read around the block of this op.",
                    },
                    block_id: {
                        type: "string",
                        description: 'Read around this block, e.g. "b42".',
                    },
                    query: {
                        type: "string",
                        description:
                            "Read around the first block containing these words.",
                    },
                    radius: {
                        type: "integer",
                        minimum: 1,
                        maximum: 30,
                        description: "Blocks to show on each side. Default 8.",
                    },
                    looking_at: lookingAt,
                },
                required: ["page", "looking_at"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const blocks =
                input.page === "before" ?
                    loaded.blocksBefore
                :   loaded.blocksAfter;
            if (!blocks)
                return fail(
                    `The text of the ${side(input.page)} page is not stored any more.`,
                );
            let centre = -1;
            if (typeof input.op === "number") {
                const op = ops[input.op];
                if (!op) return fail(`There is no op ${input.op}.`);
                const id =
                    input.page === "before" ?
                        (op.from_block_id ?? op.block_id)
                    :   op.block_id;
                centre = blocks.findIndex(b => b.id === id);
                if (centre < 0)
                    centre = blocks.findIndex(b => b.path === op.path);
                if (centre < 0)
                    return fail(
                        `The block of op ${input.op} is not on the ${side(input.page)} page (it was ${input.page === "before" ? "added" : "removed"}). Try the other page.`,
                    );
            } else if (typeof input.block_id === "string") {
                centre = blocks.findIndex(b => b.id === input.block_id);
                if (centre < 0)
                    return fail(
                        `There is no block ${input.block_id} on the ${side(input.page)} page.`,
                    );
            } else if (
                typeof input.query === "string" &&
                input.query.trim() !== ""
            ) {
                const needle = input.query.trim().toLowerCase();
                centre = blocks.findIndex(b =>
                    b.text.toLowerCase().includes(needle),
                );
                if (centre < 0)
                    return fail(
                        `No block on the ${side(input.page)} page contains "${clip(input.query, 60)}".`,
                    );
            } else {
                centre = 0;
            }
            const radius = typeof input.radius === "number" ? input.radius : 8;
            const start = Math.max(0, centre - radius);
            const end = Math.min(blocks.length, centre + radius + 1);
            const lines = blocks
                .slice(start, end)
                .map(
                    (b, i) =>
                        `${start + i === centre ? ">" : " "} ${b.id} <${b.tag}> ${b.text === "" ? "[no text: a picture or other visual content]" : `"${clip(b.text, 500)}"`}`,
                );
            return {
                content: [
                    text(
                        pageData.wrap(
                            `${side(input.page)} page, blocks ${start} to ${end - 1} of ${blocks.length}`,
                            lines.join("\n"),
                        ),
                    ),
                ],
                title: `Read ${clip(String(input.looking_at), 80)} on the ${side(input.page)} page`,
                detail: {
                    page: input.page,
                    centre: blocks[centre]?.id ?? null,
                },
            };
        },
    };

    const viewRegion: AgentTool<CompareAnswer> = {
        def: {
            name: "view_region",
            description:
                "Shows part of either screenshot at full resolution (downscaled only when very large): a numbered region with some context around it, or any box in page pixels.",
            inputSchema: {
                type: "object",
                properties: {
                    page: pageParam,
                    region: {
                        type: "integer",
                        minimum: 0,
                        description: "Index of a changed region.",
                    },
                    box: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 4,
                        maxItems: 4,
                        description:
                            "[x, y, w, h] in page pixels, instead of a region.",
                    },
                    looking_at: lookingAt,
                },
                required: ["page", "looking_at"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const image = imageOf(input.page);
            if (!image)
                return fail(
                    `The ${side(input.page)} screenshot is not stored any more.`,
                );
            let box: Rect | null;
            if (typeof input.region === "number") {
                if (!req.regions[input.region])
                    return fail(`There is no region ${input.region}.`);
                const boxes = regionBoxes(req, input.region);
                box = input.page === "before" ? boxes.before : boxes.after;
                if (!box)
                    return fail(
                        `Region ${input.region} exists only on the ${input.page === "before" ? "new" : "previous"} page.`,
                    );
            } else if (Array.isArray(input.box)) {
                box = input.box as Rect;
            } else {
                return fail("Give a region index or a box.");
            }
            const crop = await image.crop(box, { pad: regionPad });
            if (!crop)
                return fail(
                    `That box lies outside the ${side(input.page)} screenshot (${image.w}×${image.h}).`,
                );
            return {
                content: [
                    text(
                        `The ${side(input.page)} screenshot at ${boxText(crop.box)}${crop.scale < 1 ? `, scaled to ${Math.round(crop.scale * 100)}%` : ""}:`,
                    ),
                    crop.part,
                ],
                title: `Looked at ${clip(String(input.looking_at), 80)} in the ${side(input.page)} screenshot`,
                detail: { page: input.page, box: crop.box },
            };
        },
    };

    const viewScreenshot: AgentTool<CompareAnswer> = {
        def: {
            name: "view_screenshot",
            description:
                "Shows a whole screenshot, downscaled to fit. Good for layout and for finding where something is; use view_region to read detail.",
            inputSchema: {
                type: "object",
                properties: { page: pageParam },
                required: ["page"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const image = imageOf(input.page);
            if (!image)
                return fail(
                    `The ${side(input.page)} screenshot is not stored any more.`,
                );
            const whole = await image.whole();
            if (!whole) return fail("The screenshot could not be read.");
            return {
                content: [
                    text(
                        `The ${side(input.page)} screenshot, ${image.w}×${image.h} pixels, scaled to ${Math.round(whole.scale * 100)}%:`,
                    ),
                    whole.part,
                ],
                title: `Looked at the whole ${side(input.page)} screenshot`,
                detail: { page: input.page },
            };
        },
    };

    const report: AgentTool<CompareAnswer> = {
        def: {
            name: "report",
            description:
                "Gives your answer and ends the job. Every item must cite at least one valid op or region index.",
            inputSchema: {
                type: "object",
                properties: {
                    relevant: {
                        type: "boolean",
                        description:
                            "Does the difference match what the owner asked to be told about?",
                    },
                    importance: {
                        type: "string",
                        enum: ["high", "medium", "low"],
                    },
                    summary: {
                        type: "string",
                        description: "One specific sentence for the owner.",
                    },
                    items: {
                        type: "array",
                        maxItems: 30,
                        items: {
                            type: "object",
                            properties: {
                                title: {
                                    type: "string",
                                    description: "A short label.",
                                },
                                before: {
                                    type: "string",
                                    description:
                                        'What it said or looked like before; "" when new.',
                                },
                                after: {
                                    type: "string",
                                    description:
                                        'What it says or looks like now; "" when removed.',
                                },
                                kind: {
                                    type: "string",
                                    enum: ["text", "visual"],
                                },
                                matches: {
                                    type: "string",
                                    description:
                                        "The part of the Instructions this matches, in a few words.",
                                },
                                ops: {
                                    type: "array",
                                    items: { type: "integer" },
                                    description:
                                        "Indexes of the text ops that show it.",
                                },
                                regions: {
                                    type: "array",
                                    items: { type: "integer" },
                                    description:
                                        "Indexes of the regions that show it.",
                                },
                            },
                            required: [
                                "title",
                                "before",
                                "after",
                                "kind",
                                "matches",
                            ],
                            additionalProperties: false,
                        },
                    },
                    ignored: {
                        type: "array",
                        maxItems: 30,
                        items: {
                            type: "object",
                            properties: {
                                note: {
                                    type: "string",
                                    description: "The difference left out.",
                                },
                                reason: {
                                    type: "string",
                                    description: "Why, in the owner's terms.",
                                },
                            },
                            required: ["note", "reason"],
                            additionalProperties: false,
                        },
                    },
                },
                required: [
                    "relevant",
                    "importance",
                    "summary",
                    "items",
                    "ignored",
                ],
                additionalProperties: false,
            },
        },
        async run(input) {
            const problems = checkReport(req, input);
            if (problems.length > 0) {
                return {
                    content: [
                        text(
                            `The report was not accepted:\n- ${problems.join("\n- ")}\nFix this and call report again.`,
                        ),
                    ],
                    isError: true,
                    title: "Answer sent back: its evidence did not check out",
                    detail: { problems },
                };
            }
            const unique = (list: unknown) =>
                [...new Set((list ?? []) as number[])].sort((a, b) => a - b);
            const answer: CompareAnswer = {
                relevant: input.relevant === true,
                importance: input.importance as Importance,
                summary: String(input.summary).trim(),
                items: (input.items as Record<string, unknown>[]).map(item => ({
                    title: String(item.title).trim(),
                    before: String(item.before),
                    after: String(item.after),
                    kind: item.kind as CompareItem["kind"],
                    matches: String(item.matches).trim(),
                    ops: unique(item.ops),
                    regions: unique(item.regions),
                })),
                ignored: (input.ignored as Record<string, unknown>[]).map(
                    i => ({
                        note: String(i.note).trim(),
                        reason: String(i.reason).trim(),
                    }),
                ),
            };
            return {
                content: [text("Recorded.")],
                result: answer,
                title: `Answered: ${clip(answer.summary, 200)}`,
                detail: {
                    relevant: answer.relevant,
                    importance: answer.importance,
                    items: answer.items.length,
                    ignored: answer.ignored.length,
                },
            };
        },
    };

    return [readDiff, readPage, viewRegion, viewScreenshot, report];
}

type CompareAnswer = {
    relevant: boolean;
    importance: Importance;
    summary: string;
    items: CompareItem[];
    ignored: IgnoredItem[];
};

/** Runs the compare job. Throws NoConnectionError, ProviderError or AgentJobError. */
export async function compare(
    deps: AgentDeps,
    req: CompareRequest,
): Promise<CompareResponse> {
    const connection = await deps.store.resolveConnection({
        userId: req.user_id,
        connectionId: req.connection_id,
        model: req.model,
    });
    const log = deps.logger.child({
        monitorId: req.monitor_id,
        runId: req.run_id,
    });

    const quiet = <T>(
        what: string,
        load: Promise<T | null>,
    ): Promise<T | null> =>
        load.catch(err => {
            log.warn({ err }, `[compare] could not read ${what}`);
            return null;
        });
    const [before, after, blocksBefore, blocksAfter] = await Promise.all([
        quiet(
            "the previous screenshot",
            StoredImage.load(deps.objectStore, req.from.screenshot),
        ),
        quiet(
            "the new screenshot",
            StoredImage.load(deps.objectStore, req.to.screenshot),
        ),
        quiet(
            "the previous blocks",
            loadBlocks(deps.objectStore, req.from.blocks),
        ),
        quiet("the new blocks", loadBlocks(deps.objectStore, req.to.blocks)),
    ]);
    const loaded: Loaded = { before, after, blocksBefore, blocksAfter };

    const pageData = new PageData();
    const groups = groupEvidence(req);
    const evidence = renderEvidence(req, groups);
    const images = await firstImages(req, groups, loaded);

    const trace = await Trace.open(
        deps.store,
        {
            runId: req.run_id,
            macroId: null,
            monitorId: req.monitor_id,
            userId: req.user_id,
        },
        log,
    );

    const run = await runAgent<CompareAnswer>({
        adapter: adapterOf(deps, connection),
        system: systemPrompt(pageData),
        tools: compareTools(req, loaded, pageData),
        first: firstMessage(req, evidence, images, pageData),
        limits: compareLimits,
        finishHint: "call report",
        onTool: traceTools(trace, "compare"),
    });
    if (!run.result) {
        throw new AgentJobError(
            "provider_error",
            stopMessage(run.stopped, run.steps),
        );
    }
    log.info(
        { relevant: run.result.relevant, steps: run.steps, usage: run.usage },
        "[compare] answered",
    );
    return {
        ...run.result,
        model: run.model,
        input_tokens: run.usage.inputTokens,
        output_tokens: run.usage.outputTokens,
        steps: run.steps,
    };
}
