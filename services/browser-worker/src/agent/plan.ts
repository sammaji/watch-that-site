import {
    DEFAULT_INSTRUCTIONS,
    pathUnder,
    WATCH_HOWS,
    WATCH_PLAN_MAX_SECTIONS,
    type CaptureBlock,
    type PlanLoad,
    type PlanRequest,
    type PlanResponse,
    type Rect,
    type WatchHow,
    type WatchPlan,
    type WatchSection,
} from "@watchthatsite/types";
import { planLimits } from "../config/constants.js";
import { Trace } from "../store/trace.js";
import { loadBlocks } from "./blocks.js";
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
 * The plan job: the Agent reads the owner's Instructions, looks at one
 * Capture (its block outline and its screenshot) and divides the page into
 * Sections, each watched as text, visual, both, or ignored.
 *
 * The model points at blocks by index; this code turns the indexes into the
 * XPaths a Watch Plan stores. The model never writes an XPath of its own.
 */

const BODY = "/html[1]/body[1]";
const outlineTextChars = 80;
const outlineMaxLines = 450;
const listPageSize = 150;

/** A path as the outline shows it: no `/html/body`, no `[1]`. */
export function shortPath(path: string): string {
    const rest = path.startsWith(BODY) ? path.slice(BODY.length) : path;
    const short = rest.replace(/\[1\](?=\/|$)/g, "").replace(/^\//, "");
    return short === "" ? "body" : short;
}

/** Path steps without `/html/body` and without `[1]`, for comparing paths however they were written. */
function canon(path: string): string[] {
    const steps = path
        .trim()
        .split("/")
        .map(s =>
            s
                .trim()
                .toLowerCase()
                .replace(/\[1\]$/, ""),
        )
        .filter(s => s !== "" && s !== ".");
    if (steps[0] === "html") steps.shift();
    if (steps[0] === "body") steps.shift();
    return steps;
}

/**
 * The absolute XPath a path from the outline stands for: the path of a block,
 * or the beginning of one (an element that contains blocks). Null when no
 * block is at or under it.
 */
export function resolvePath(
    blocks: CaptureBlock[],
    given: string,
): string | null {
    const want = canon(given);
    for (const block of blocks) {
        const have = canon(block.path);
        if (have.length < want.length) continue;
        if (!want.every((step, i) => have[i] === step)) continue;
        // The same number of steps on the real path, past /html/body.
        const real = block.path.split("/").filter(Boolean);
        const offset =
            real[0]?.startsWith("html") && real[1]?.startsWith("body") ? 2 : 0;
        return `/${real.slice(0, offset + want.length).join("/")}`;
    }
    return null;
}

/** Every path that has blocks under it, with the first and last block index it holds. */
function subtreeRanges(blocks: CaptureBlock[]): Map<string, [number, number]> {
    const ranges = new Map<string, [number, number]>();
    blocks.forEach((block, index) => {
        let end = block.path.length;
        while (end > 0) {
            const prefix = block.path.slice(0, end);
            const range = ranges.get(prefix);
            if (range) {
                range[0] = Math.min(range[0], index);
                range[1] = Math.max(range[1], index);
            } else {
                ranges.set(prefix, [index, index]);
            }
            end = block.path.lastIndexOf("/", end - 1);
        }
    });
    return ranges;
}

/**
 * The paths that root a Section made of the blocks in `mine`.
 *
 * Each root is the largest element whose blocks all belong to the Section:
 * from every block, climb while the parent still holds nothing but the
 * Section's blocks. So a Section takes the whole card, table or figure its
 * blocks fill (images and other non-text content inside it included), and
 * never an ancestor that also holds a neighbouring Section's text.
 */
export function rootsFor(blocks: CaptureBlock[], mine: Set<number>): string[] {
    const ranges = subtreeRanges(blocks);
    const within = (path: string): boolean => {
        const range = ranges.get(path);
        if (!range) return false;
        for (let i = range[0]; i <= range[1]; i++) {
            // Blocks are in document order, so an element's blocks are the
            // contiguous run between its first and last.
            if (!mine.has(i)) return false;
        }
        return true;
    };
    const roots: string[] = [];
    for (const index of [...mine].sort((a, b) => a - b)) {
        const block = blocks[index];
        if (!block) continue;
        if (roots.some(root => pathUnder(block.path, root))) continue;
        let root = block.path;
        for (;;) {
            if (root === BODY) break;
            const cut = root.lastIndexOf("/");
            if (cut <= 0) break;
            const parent = root.slice(0, cut);
            if (parent === "/html[1]" || !within(parent)) break;
            root = parent;
        }
        roots.push(root);
    }
    return roots;
}

/** What a block without text is, so the model knows there is something to look at. */
function visualKind(tag: string): string {
    switch (tag) {
        case "img":
            return "an image";
        case "svg":
        case "canvas":
            return "a drawing or chart";
        case "video":
            return "a video";
        case "iframe":
        case "object":
        case "embed":
            return "an embedded frame";
        default:
            return "a background image";
    }
}

function outlineLine(
    block: CaptureBlock,
    index: number,
    textChars = outlineTextChars,
): string {
    const what =
        block.text === "" ?
            `[no text: ${visualKind(block.tag)}]`
        :   `"${clip(block.text, textChars)}"`;
    return `[${index}] ${shortPath(block.path)} <${block.tag}> ${what} (${block.rect.join(",")})`;
}

/**
 * Marks blocks to leave out of the outline: where an element has more than
 * `keep + 2` children of the same tag (list items, table rows, cards), the
 * first `keep` and the last one stay and the ones between are hidden.
 */
function hiddenBlocks(blocks: CaptureBlock[], keep: number): boolean[] {
    const hidden = new Array<boolean>(blocks.length).fill(false);
    // parent path + child tag -> the distinct children of that tag, in order.
    const families = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const block of blocks) {
        let end = block.path.length;
        while (end > BODY.length) {
            const child = block.path.slice(0, end);
            if (seen.has(child)) break;
            seen.add(child);
            const cut = child.lastIndexOf("/");
            const key = `${child.slice(0, cut)}|${child.slice(cut + 1).replace(/\[\d+\]$/, "")}`;
            const family = families.get(key);
            if (family) family.push(child);
            else families.set(key, [child]);
            end = cut;
        }
    }
    const ranges = subtreeRanges(blocks);
    for (const family of families.values()) {
        if (family.length <= keep + 2) continue;
        for (const child of family.slice(keep, -1)) {
            const range = ranges.get(child);
            if (!range) continue;
            for (let i = range[0]; i <= range[1]; i++) hidden[i] = true;
        }
    }
    return hidden;
}

export type Outline = {
    text: string;
    /** How many blocks were left out, 0 when the outline is complete. */
    hidden: number;
};

/**
 * The page's block outline: one line per block, with long runs of sibling
 * elements shortened so a big page still fits. Each gap says which blocks it
 * stands for.
 */
export function renderOutline(
    blocks: CaptureBlock[],
    maxLines = outlineMaxLines,
): Outline {
    // Try gentler shortening first; a page of a thousand rows needs the hardest.
    for (const keep of [Infinity, 6, 3, 1]) {
        const hidden =
            keep === Infinity ?
                new Array<boolean>(blocks.length).fill(false)
            :   hiddenBlocks(blocks, keep);
        const lines: string[] = [];
        let count = 0;
        for (let i = 0; i < blocks.length; i++) {
            if (!hidden[i]) {
                lines.push(outlineLine(blocks[i]!, i));
                continue;
            }
            let j = i;
            while (j + 1 < blocks.length && hidden[j + 1]) j++;
            count += j - i + 1;
            lines.push(
                `    … blocks ${i} to ${j} not shown: ${j - i + 1} more like the ones above. list_blocks shows them.`,
            );
            i = j;
        }
        if (lines.length <= maxLines || keep === 1) {
            if (lines.length > maxLines) {
                const cut = lines.slice(0, maxLines);
                const last = /^\[(\d+)\]/.exec(
                    cut.findLast(l => l.startsWith("[")) ?? "",
                );
                const from = last ? Number(last[1]) + 1 : 0;
                cut.push(
                    `    … the outline stops here: blocks ${from} to ${blocks.length - 1} are not shown because the page is very long. list_blocks shows them.`,
                );
                return {
                    text: cut.join("\n"),
                    hidden: blocks.length - from + count,
                };
            }
            return { text: lines.join("\n"), hidden: count };
        }
    }
    return { text: "", hidden: 0 };
}

function slug(value: string): string {
    return (
        value
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "section"
    );
}

export type PlanCheck =
    | { ok: true; sections: WatchSection[]; rest: WatchHow; summary: string }
    | { ok: false; problems: string[] };

/**
 * Turns the model's `submit_plan` input into Sections with paths, or says
 * what is wrong with it in words the model can act on.
 */
export function buildPlan(
    blocks: CaptureBlock[],
    input: Record<string, unknown>,
    previous: WatchPlan | null,
): PlanCheck {
    const problems: string[] = [];
    const given =
        Array.isArray(input.sections) ?
            (input.sections as Record<string, unknown>[])
        :   [];
    if (given.length > WATCH_PLAN_MAX_SECTIONS) {
        problems.push(
            `a plan may hold at most ${WATCH_PLAN_MAX_SECTIONS} Sections and this one has ${given.length}: merge Sections that are watched the same way`,
        );
    }
    const isHow = (v: unknown): v is WatchHow =>
        WATCH_HOWS.includes(v as WatchHow);
    if (!isHow(input.rest)) {
        problems.push(`rest must be one of ${WATCH_HOWS.join(", ")}`);
    }
    const summary =
        typeof input.summary === "string" ? input.summary.trim() : "";
    if (summary === "") problems.push("summary is empty");

    const sections: WatchSection[] = [];
    const ids = new Set<string>();
    given.forEach((raw, i) => {
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        const label = `sections[${i}]${name ? ` ("${clip(name, 40)}")` : ""}`;
        if (name === "") problems.push(`${label} has no name`);
        if (!isHow(raw.how)) {
            problems.push(
                `${label}: how must be one of ${WATCH_HOWS.join(", ")}, not ${JSON.stringify(raw.how)}`,
            );
        }
        const why = typeof raw.why === "string" ? raw.why.trim() : "";
        if (why === "") problems.push(`${label} has no why`);

        let paths: string[] = [];
        if (typeof raw.path === "string" && raw.path.trim() !== "") {
            const root = resolvePath(blocks, raw.path);
            if (root === null) {
                problems.push(
                    `${label}: no block is at or under the path "${clip(raw.path, 80)}". Copy a path from the outline, or give block indexes instead`,
                );
            } else {
                paths = [root];
            }
        } else {
            const mine = new Set<number>();
            const ranges =
                Array.isArray(raw.blocks) ? (raw.blocks as unknown[]) : [];
            for (const range of ranges) {
                const [from, to] =
                    Array.isArray(range) ?
                        (range as number[])
                    :   [range as number, range as number];
                if (
                    !Number.isInteger(from) ||
                    !Number.isInteger(to) ||
                    from! < 0 ||
                    to! < from! ||
                    to! >= blocks.length
                ) {
                    problems.push(
                        `${label}: the block range [${String(from)}, ${String(to)}] is not valid (blocks run from 0 to ${blocks.length - 1})`,
                    );
                    continue;
                }
                for (let b = from!; b <= to!; b++) mine.add(b);
            }
            paths = rootsFor(blocks, mine);
            if (
                paths.length === 0 &&
                !problems.some(p => p.startsWith(label))
            ) {
                problems.push(
                    `${label} matches no block: give blocks as [first, last] index ranges from the outline, or a path copied from it`,
                );
            }
        }

        // Keep the id the Section had before, so the owner's history stays attached.
        const wanted =
            typeof raw.id === "string" && raw.id.trim() !== "" ?
                slug(raw.id)
            :   (previous?.sections.find(
                    s => s.name.toLowerCase() === name.toLowerCase(),
                )?.id ?? slug(name));
        let id = wanted;
        for (let n = 2; ids.has(id); n++) id = `${wanted}-${n}`;
        ids.add(id);
        sections.push({ id, name, how: raw.how as WatchHow, why, paths });
    });

    // Two Sections rooted at the same element cannot both own it.
    const owners = new Map<string, string>();
    for (const section of sections) {
        for (const path of section.paths) {
            const other = owners.get(path);
            if (other && other !== section.name) {
                problems.push(
                    `Sections "${other}" and "${section.name}" both cover ${shortPath(path)}: give each its own blocks, or merge them`,
                );
            }
            owners.set(path, section.name);
        }
    }

    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, sections, rest: input.rest as WatchHow, summary };
}

/** How this Capture's page loaded, in words, for deciding wait_ms. */
function loadText(load: PlanLoad | null): string {
    if (!load) {
        return "How the page loaded is not known for this Capture: set wait_ms to 0 unless the screenshot shows content still loading.";
    }
    const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    return [
        "How the page loaded for this Capture:",
        `- reached the load event after ${s(load.load_ms)}, then took ${s(load.settle_ms)} more to settle (network quiet, scrolling through for lazy content, and the wait).`,
        load.network_quiet ?
            "- the network went quiet (half a second without requests)."
        :   "- the network never went quiet within 10 s: requests kept coming (polling, analytics, streaming, or content still arriving).",
        load.stable ?
            "- two screenshots in a row matched."
        :   `- two screenshots in a row differed in ${load.moving_regions} region(s): something was still moving or changing.`,
        `- the Capture already waited ${s(load.wait_ms)} extra before the screenshot.`,
    ].join("\n");
}

function systemPrompt(pageData: PageData): string {
    return `You work inside WatchThatSite, a service that watches a web page for its owner and tells them when something they care about changes. Before a Monitor starts comparing Captures of its page, you divide the page into Sections and decide how each one is watched. This Watch Plan is then applied on every Run, so it decides what the owner hears about.

How a Section can be watched
- text: the words matter (prices, terms, listings, availability). Compared word by word.
- visual: the look matters (a hero image, a chart, a map, colour or layout the owner cares about). Compared as an image, the Section's crop against its crop on the previous Capture.
- both: words and look.
- ignore: the owner does not care. Differences here are dropped before anyone sees them.

Choosing
Decide from what the owner asked and from what the content is. Words that matter are text. Pictures, charts, maps, and colour or layout the owner cares about are visual, or both when the words in them matter too. What the Instructions say to ignore is ignore, and so is obvious Noise: ads, cookie banners, rotating testimonials, "last updated" lines, counters.
ignore is the only choice that can hide something from the owner, so be sparing with it. A difference in a watched part still goes to a reader who knows the Instructions and decides whether it matters; a difference in an ignored part is never seen by anyone.
rest says how everything outside your Sections is watched. Use text. Use ignore only when the Instructions say in so many words that nothing else matters ("ignore everything else", "only tell me about the price"). Naming what the owner cares about is not the same as saying the rest does not matter.
Make a Section as wide as the thing it is about, including the room where more of it would appear: the whole list of plans, not the three price lines inside it, so that a fourth plan added later lands inside the Section and not outside it. A Section drawn tightly around today's content misses tomorrow's.
Name Sections the way a person would: "Pricing table", "Hero image", "Testimonials", "Footer". Do not over-partition. A part of the page needs its own Section when it is watched differently from what surrounds it, or when the owner named it; 3 to 10 Sections is typical.
why is one plain sentence per Section, written for the owner. summary is one or two sentences for the owner on how the page will be watched, such as "Watching the three plan cards for price and feature changes, and the hero image for a new look. Ignoring testimonials and the footer."

Saying where a Section is
The outline lists the page's visible blocks in page order: an index, a path, the tag, the start of the text, and the rectangle (x, y, width, height in page pixels). Pictures, charts, videos, embedded frames and background images are blocks too; they have no text and their line says so. Say where a Section is with blocks: [first, last] index ranges, inclusive, covering everything in the Section. The Section then takes the page elements that hold exactly those blocks. Or give path: a path copied from the outline, or the beginning of one, to take that whole element. Do not write paths of your own.
A Section watched as visual or both is compared as the rectangle around its blocks, so include the block of the picture or chart itself, not only the caption next to it. The outline says that a picture is there, not what it shows: the screenshot shows what the page looks like, and rectangles tell you which block is which.

Waiting for the page
Each Capture is taken once the page stops loading, and you are told how that went: how long it took, whether the network went quiet, whether two screenshots in a row matched, and how long the Capture already waited. Some pages keep filling in after that: a spinner, grey skeleton boxes, an empty chart or table, a price or a list that is not there yet. Set wait_ms, the extra wait before each Capture:
- The screenshot shows content still arriving, or the network never went quiet and the page looks unfinished: more than it had, enough for the page to finish (a slow page that took 6 s to settle may need 3000 to 5000 more). Up to 20000.
- The page looks complete and it already had a wait: keep that wait, since it may be why it looks complete.
- The page looks complete without one: 0. A page whose network never goes quiet because of analytics or polling, but looks complete, needs no wait. Moving regions from animation or video are masked already and need none either.
Every second of waiting is spent on every Run, so do not wait without a reason.

${ELEMENT_REFERENCES}

Tools: view_region shows part of the screenshot at full resolution, read_block shows a block's full text and its neighbours, list_blocks lists the blocks under a path (for parts the outline shortened). Finish by calling submit_plan once.

${pageData.rule}`;
}

function previousPlanText(previous: WatchPlan): string {
    const byHand = previous.model === "";
    const lines = [
        byHand ?
            "The Watch Plan being replaced was last edited by the owner:"
        :   "The Watch Plan being replaced:",
    ];
    for (const s of previous.sections) {
        lines.push(
            `- id "${s.id}", "${s.name}", watched as ${s.how}, at ${s.paths.map(shortPath).join(" and ")}. ${s.why}`,
        );
    }
    lines.push(`- rest: ${previous.rest}`);
    lines.push(
        "Where a Section is still on the page, give it the same id.",
        byHand ?
            "The owner chose how these Sections are watched: keep each Section's how as it is, unless the Section is gone."
        :   "",
    );
    return lines.filter(Boolean).join("\n");
}

type PlanAnswer = {
    sections: WatchSection[];
    rest: WatchHow;
    summary: string;
    /** Extra milliseconds to wait before each Capture, 0 to 20000. */
    wait_ms: number;
};

const MAX_WAIT_MS = 20_000;

function planTools(
    blocks: CaptureBlock[],
    screenshot: StoredImage | null,
    previous: WatchPlan | null,
    pageData: PageData,
): AgentTool<PlanAnswer>[] {
    const fail = (message: string): ToolOutcome<PlanAnswer> => ({
        content: [text(message)],
        isError: true,
        title: null,
    });
    const lookingAt = {
        type: "string" as const,
        description:
            'A few words on what you are looking at, shown to the owner in the trace: "the chart under the heading".',
    };

    const viewRegion: AgentTool<PlanAnswer> = {
        def: {
            name: "view_region",
            description:
                "Shows part of the screenshot at full resolution (downscaled only when very large).",
            inputSchema: {
                type: "object",
                properties: {
                    box: {
                        type: "array",
                        items: { type: "integer" },
                        minItems: 4,
                        maxItems: 4,
                        description: "[x, y, w, h] in page pixels.",
                    },
                    looking_at: lookingAt,
                },
                required: ["box", "looking_at"],
                additionalProperties: false,
            },
        },
        async run(input) {
            if (!screenshot)
                return fail("This Capture has no stored screenshot.");
            const crop = await screenshot.crop(input.box as Rect);
            if (!crop)
                return fail(
                    `That box lies outside the screenshot (${screenshot.w}×${screenshot.h}).`,
                );
            return {
                content: [
                    text(
                        `The screenshot at ${boxText(crop.box)}${crop.scale < 1 ? `, scaled to ${Math.round(crop.scale * 100)}%` : ""}:`,
                    ),
                    crop.part,
                ],
                title: `Looked at ${clip(String(input.looking_at), 80)} in the screenshot`,
                detail: { box: crop.box },
            };
        },
    };

    const readBlock: AgentTool<PlanAnswer> = {
        def: {
            name: "read_block",
            description:
                "Shows the full text of a block and of the blocks around it.",
            inputSchema: {
                type: "object",
                properties: {
                    index: { type: "integer", minimum: 0 },
                    neighbours: {
                        type: "integer",
                        minimum: 0,
                        maximum: 20,
                        description: "Blocks to show on each side. Default 3.",
                    },
                },
                required: ["index"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const index = input.index as number;
            if (index >= blocks.length)
                return fail(`Blocks run from 0 to ${blocks.length - 1}.`);
            const around =
                typeof input.neighbours === "number" ? input.neighbours : 3;
            const start = Math.max(0, index - around);
            const end = Math.min(blocks.length, index + around + 1);
            const lines = blocks
                .slice(start, end)
                .map(
                    (b, i) =>
                        `${start + i === index ? ">" : " "} ${outlineLine(b, start + i, start + i === index ? 4000 : 400)}`,
                );
            return {
                content: [text(pageData.wrap("blocks", lines.join("\n")))],
                title: `Read block ${index} and the text around it`,
                detail: { index },
            };
        },
    };

    const listBlocks: AgentTool<PlanAnswer> = {
        def: {
            name: "list_blocks",
            description:
                "Lists every block under a path from the outline, including the ones the outline left out.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            'A path copied from the outline, or the beginning of one. "body" lists the whole page.',
                    },
                    from: {
                        type: "integer",
                        minimum: 0,
                        description:
                            "Skip blocks before this index, to continue a long listing.",
                    },
                },
                required: ["path"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const root =
                String(input.path).trim().toLowerCase() === "body" ?
                    BODY
                :   resolvePath(blocks, String(input.path));
            if (root === null)
                return fail(
                    `No block is at or under "${clip(String(input.path), 80)}". Copy a path from the outline.`,
                );
            const from = typeof input.from === "number" ? input.from : 0;
            const under = blocks
                .map((block, index) => ({ block, index }))
                .filter(
                    ({ block, index }) =>
                        index >= from && pathUnder(block.path, root),
                );
            const lines = under
                .slice(0, listPageSize)
                .map(({ block, index }) => outlineLine(block, index));
            if (under.length > listPageSize) {
                lines.push(
                    `… ${under.length - listPageSize} more: call list_blocks again with from=${under[listPageSize]!.index}.`,
                );
            }
            return {
                content: [
                    text(
                        pageData.wrap(
                            `blocks under ${shortPath(root)}`,
                            lines.join("\n") || "(none)",
                        ),
                    ),
                ],
                title: `Listed the blocks under ${clip(shortPath(root), 80)}`,
                detail: { path: root, count: under.length },
            };
        },
    };

    const submit: AgentTool<PlanAnswer> = {
        def: {
            name: "submit_plan",
            description: "Gives the Watch Plan and ends the job.",
            inputSchema: {
                type: "object",
                properties: {
                    sections: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string",
                                    description:
                                        "The id this Section had in the previous plan, when it is the same Section. Leave out for a new one.",
                                },
                                name: {
                                    type: "string",
                                    description:
                                        'What a person would call it: "Pricing table".',
                                },
                                how: { type: "string", enum: WATCH_HOWS },
                                why: {
                                    type: "string",
                                    description:
                                        "One sentence for the owner: why it is watched this way.",
                                },
                                blocks: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: { type: "integer" },
                                        minItems: 2,
                                        maxItems: 2,
                                    },
                                    description:
                                        "The Section's blocks as [first, last] index ranges, inclusive. One block is [i, i].",
                                },
                                path: {
                                    type: "string",
                                    description:
                                        "Instead of blocks: a path copied from the outline, or the beginning of one.",
                                },
                            },
                            required: ["name", "how", "why"],
                            additionalProperties: false,
                        },
                    },
                    rest: {
                        type: "string",
                        enum: WATCH_HOWS,
                        description:
                            "How everything outside the Sections is watched.",
                    },
                    summary: {
                        type: "string",
                        description:
                            "One or two sentences for the owner on how the page will be watched.",
                    },
                    wait_ms: {
                        type: "integer",
                        description:
                            "Extra milliseconds to wait, after the page stops loading, before each Capture: 0 unless the screenshot shows content still arriving (spinners, skeleton placeholders, empty charts or tables, a price not filled in yet). Up to 20000.",
                    },
                },
                required: ["sections", "rest", "summary", "wait_ms"],
                additionalProperties: false,
            },
        },
        async run(input) {
            const built = buildPlan(blocks, input, previous);
            if (!built.ok) {
                return {
                    content: [
                        text(
                            `The plan was not accepted:\n- ${built.problems.join("\n- ")}\nFix this and call submit_plan again.`,
                        ),
                    ],
                    isError: true,
                    title: "Plan sent back: it did not fit the page",
                    detail: { problems: built.problems },
                };
            }
            return {
                content: [text("Recorded.")],
                result: {
                    sections: built.sections,
                    rest: built.rest,
                    summary: built.summary,
                    wait_ms: Math.min(
                        MAX_WAIT_MS,
                        Math.max(0, Math.round(Number(input.wait_ms) || 0)),
                    ),
                },
                title: `Planned: ${clip(built.summary, 200)}`,
                detail: {
                    sections: built.sections.map(s => ({
                        id: s.id,
                        how: s.how,
                    })),
                    rest: built.rest,
                },
            };
        },
    };

    return [viewRegion, readBlock, listBlocks, submit];
}

/** Runs the plan job. Throws NoConnectionError, ProviderError or AgentJobError. */
export async function plan(
    deps: AgentDeps,
    req: PlanRequest,
): Promise<PlanResponse> {
    const connection = await deps.store.resolveConnection({
        userId: req.user_id,
        connectionId: req.connection_id,
        model: req.model,
    });
    const log = deps.logger.child({
        monitorId: req.monitor_id,
        runId: req.run_id,
    });

    const blocks = await loadBlocks(deps.objectStore, req.capture.blocks);
    if (!blocks || blocks.length === 0) {
        throw new AgentJobError(
            "not_found",
            "The blocks of this Capture are not stored, so there is nothing to plan from",
        );
    }
    const screenshot = await StoredImage.load(
        deps.objectStore,
        req.capture.screenshot,
    ).catch(err => {
        log.warn({ err }, "[plan] could not read the screenshot");
        return null;
    });

    const pageData = new PageData();
    const outline = renderOutline(blocks);
    const instructions = req.monitor.instructions.trim();
    const first: ContentPart[] = [
        text(
            [
                `Monitor: ${req.monitor.name}`,
                `URL: ${req.monitor.url}`,
                "",
                instructions ?
                    `The owner's Instructions:\n"""\n${instructions}\n"""`
                :   `The owner wrote no Instructions, so the default applies:\n"""\n${DEFAULT_INSTRUCTIONS}\n"""`,
                ...(req.previous ? ["", previousPlanText(req.previous)] : []),
                "",
                loadText(req.load),
                "",
                `The page's outline: ${blocks.length} blocks${outline.hidden > 0 ? `, of which ${outline.hidden} in long runs of similar elements are left out and marked` : ""}.`,
                pageData.wrap("outline", outline.text),
            ].join("\n"),
        ),
    ];
    if (screenshot) {
        const tiles = await screenshot.tiles();
        tiles.forEach((tile, i) => {
            first.push(
                text(
                    `The screenshot (${screenshot.w}×${screenshot.h} pixels), part ${i + 1} of ${tiles.length}: page y from ${tile.box[1]} to ${tile.box[1] + tile.box[3]}, scaled to ${Math.round(tile.scale * 100)}%:`,
                ),
                tile.part,
            );
        });
    } else {
        first.push(
            text(
                "This Capture has no stored screenshot; plan from the outline alone.",
            ),
        );
    }

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

    const run = await runAgent<PlanAnswer>({
        adapter: adapterOf(deps, connection),
        system: systemPrompt(pageData),
        tools: planTools(blocks, screenshot, req.previous, pageData),
        first,
        limits: planLimits,
        finishHint: "call submit_plan",
        onTool: traceTools(trace, "plan"),
    });
    if (!run.result) {
        throw new AgentJobError(
            "provider_error",
            stopMessage(run.stopped, run.steps),
        );
    }
    log.info(
        {
            sections: run.result.sections.length,
            steps: run.steps,
            usage: run.usage,
        },
        "[plan] answered",
    );
    return {
        ...run.result,
        model: run.model,
        input_tokens: run.usage.inputTokens,
        output_tokens: run.usage.outputTokens,
        steps: run.steps,
    };
}
