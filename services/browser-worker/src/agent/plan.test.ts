import type {
    CaptureBlock,
    PlanRequest,
    WatchPlan,
} from "@watchthatsite/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { block, drawPng, storeCapture } from "../testing/captures.js";
import { FakeProvider, type LooseJson } from "../testing/fake-provider.js";
import { FakeStore } from "../testing/fake-store.js";
import {
    MemoryStore,
    MONITOR_ID,
    RUN_ID,
    silentLogger,
} from "../testing/harness.js";
import { AgentJobError } from "./job.js";
import {
    buildPlan,
    plan,
    renderOutline,
    resolvePath,
    rootsFor,
    shortPath,
} from "./plan.js";

const BODY = "/html[1]/body[1]";
const MAIN = `${BODY}/main[1]`;

/**
 * A page with a hero (heading and line inside one wrapper, next to an image),
 * three plan cards, a testimonials list, loose paragraphs, and a footer.
 */
const blocks: CaptureBlock[] = [
    block(
        0,
        `${MAIN}/div[1]/h1[1]`,
        "Ship faster with Acme",
        [20, 20, 400, 40],
    ),
    block(
        1,
        `${MAIN}/div[1]/p[1]`,
        "The platform for busy teams",
        [20, 60, 400, 20],
    ),
    block(2, `${MAIN}/section[1]/h2[1]`, "Pricing", [20, 300, 760, 30]),
    block(3, `${MAIN}/section[1]/div[1]/h3[1]`, "Starter", [20, 340, 240, 20]),
    block(
        4,
        `${MAIN}/section[1]/div[1]/p[1]`,
        "$9 a month",
        [20, 360, 240, 20],
    ),
    block(5, `${MAIN}/section[1]/div[2]/h3[1]`, "Pro", [270, 340, 240, 20]),
    block(
        6,
        `${MAIN}/section[1]/div[2]/p[1]`,
        "$49 a month",
        [270, 360, 240, 20],
    ),
    block(7, `${MAIN}/section[1]/div[3]/h3[1]`, "Team", [520, 340, 240, 20]),
    block(
        8,
        `${MAIN}/section[1]/div[3]/p[1]`,
        "$99 a month",
        [520, 360, 240, 20],
    ),
    block(
        9,
        `${MAIN}/section[2]/h2[1]`,
        "What customers say",
        [20, 420, 760, 30],
    ),
    block(
        10,
        `${MAIN}/section[2]/blockquote[1]`,
        "Acme changed how we work.",
        [20, 460, 760, 40],
    ),
    block(11, `${MAIN}/p[1]`, "Questions? Write to us.", [20, 520, 760, 20]),
    block(
        12,
        `${MAIN}/p[2]`,
        "Last updated 21 November 2026",
        [20, 540, 760, 20],
    ),
    block(13, `${BODY}/footer[1]/p[1]`, "© 2026 Acme Inc.", [20, 580, 760, 20]),
];

describe("paths", () => {
    it("shortens a path for the outline and finds it again", () => {
        expect(shortPath(`${MAIN}/section[2]/div[1]/h3[1]`)).toBe(
            "main/section[2]/div/h3",
        );
        expect(shortPath(BODY)).toBe("body");
        // A block's own path, the beginning of one, with or without indexes and prefix.
        expect(resolvePath(blocks, "main/section/div[2]/p")).toBe(
            `${MAIN}/section[1]/div[2]/p[1]`,
        );
        expect(resolvePath(blocks, "main/section")).toBe(`${MAIN}/section[1]`);
        expect(resolvePath(blocks, "/html/body/main/section[2]")).toBe(
            `${MAIN}/section[2]`,
        );
        expect(resolvePath(blocks, `${MAIN}/div[1]`)).toBe(`${MAIN}/div[1]`);
        expect(resolvePath(blocks, "footer")).toBe(`${BODY}/footer[1]`);
        expect(resolvePath(blocks, "main/aside")).toBeNull();
        expect(resolvePath(blocks, "main/section[3]")).toBeNull();
    });
});

describe("turning block indexes into Section paths", () => {
    const roots = (...indexes: number[]) => rootsFor(blocks, new Set(indexes));

    it("takes the element that holds exactly the Section's blocks", () => {
        // Both hero blocks: their wrapper, which also holds the hero image.
        expect(roots(0, 1)).toEqual([`${MAIN}/div[1]`]);
        // The whole pricing section.
        expect(roots(2, 3, 4, 5, 6, 7, 8)).toEqual([`${MAIN}/section[1]`]);
        // One card.
        expect(roots(5, 6)).toEqual([`${MAIN}/section[1]/div[2]`]);
        // A single block inside a card stays that block.
        expect(roots(6)).toEqual([`${MAIN}/section[1]/div[2]/p[1]`]);
    });

    it("never takes an ancestor that would swallow a neighbour", () => {
        // Two loose paragraphs under main: main also holds pricing and the hero.
        expect(roots(11, 12)).toEqual([`${MAIN}/p[1]`, `${MAIN}/p[2]`]);
        // Two of three cards: the two cards, not the pricing section.
        expect(roots(3, 4, 5, 6)).toEqual([
            `${MAIN}/section[1]/div[1]`,
            `${MAIN}/section[1]/div[2]`,
        ]);
        // Everything under main: main itself, not body (the footer is not in it).
        expect(roots(...Array.from({ length: 13 }, (_, i) => i))).toEqual([
            MAIN,
        ]);
        // The whole page stops at body.
        expect(roots(...blocks.map((_, i) => i))).toEqual([BODY]);
        expect(roots()).toEqual([]);
    });
});

describe("the block outline", () => {
    it("gives one line per block: index, short path, tag, text and rectangle", () => {
        const outline = renderOutline(blocks);
        expect(outline.hidden).toBe(0);
        const lines = outline.text.split("\n");
        expect(lines).toHaveLength(14);
        expect(lines[0]).toBe(
            '[0] main/div/h1 <h1> "Ship faster with Acme" (20,20,400,40)',
        );
        expect(lines[6]).toBe(
            '[6] main/section/div[2]/p <p> "$49 a month" (270,360,240,20)',
        );
    });

    it("lists a picture as a block with no text, so a visual Section can be rooted on it", () => {
        const withMedia = [
            block(0, `${MAIN}/div[1]/img[1]`, "", [440, 20, 340, 240]),
            block(1, `${MAIN}/div[1]/h1[1]`, "Ship faster", [20, 20, 400, 40]),
            block(2, `${MAIN}/canvas[1]`, "", [20, 300, 600, 200]),
            block(3, `${MAIN}/div[2]`, "", [0, 520, 800, 300]),
            block(4, `${MAIN}/p[1]`, "Updated daily", [20, 840, 400, 20]),
        ];
        expect(renderOutline(withMedia).text.split("\n")).toEqual([
            "[0] main/div/img <img> [no text: an image] (440,20,340,240)",
            '[1] main/div/h1 <h1> "Ship faster" (20,20,400,40)',
            "[2] main/canvas <canvas> [no text: a drawing or chart] (20,300,600,200)",
            "[3] main/div[2] <div> [no text: a background image] (0,520,800,300)",
            '[4] main/p <p> "Updated daily" (20,840,400,20)',
        ]);
        // The hero's picture and headline together root the Section at their wrapper...
        expect(rootsFor(withMedia, new Set([0, 1]))).toEqual([
            `${MAIN}/div[1]`,
        ]);
        // ...and a chart with no text at all can be a Section of its own.
        const built = buildPlan(
            withMedia,
            {
                sections: [
                    {
                        name: "Revenue chart",
                        how: "visual",
                        why: "You asked about the chart.",
                        blocks: [[2, 2]],
                    },
                ],
                rest: "text",
                summary: "s",
            },
            null,
        );
        expect(built.ok && built.sections[0]!.paths).toEqual([
            `${MAIN}/canvas[1]`,
        ]);
    });

    it("cuts text to about 80 characters", () => {
        const long = [
            block(0, `${MAIN}/p[1]`, "word ".repeat(60), [0, 0, 10, 10]),
        ];
        const line = renderOutline(long).text;
        expect(line.length).toBeLessThan(130);
        expect(line).toContain("…");
    });

    it("shortens long runs of sibling elements and says which blocks it left out", () => {
        const rows: CaptureBlock[] = [
            block(0, `${MAIN}/h1[1]`, "Listings", [0, 0, 800, 40]),
        ];
        for (let i = 0; i < 400; i++) {
            rows.push(
                block(
                    rows.length,
                    `${MAIN}/ul[1]/li[${i + 1}]/h3[1]`,
                    `Flat ${i}`,
                    [0, 40 + i * 40, 800, 20],
                ),
            );
            rows.push(
                block(
                    rows.length,
                    `${MAIN}/ul[1]/li[${i + 1}]/p[1]`,
                    `€${900 + i} a month`,
                    [0, 60 + i * 40, 800, 20],
                ),
            );
        }
        rows.push(
            block(
                rows.length,
                `${BODY}/footer[1]/p[1]`,
                "© Acme",
                [0, 16100, 800, 20],
            ),
        );

        const outline = renderOutline(rows);
        const lines = outline.text.split("\n");
        expect(lines.length).toBeLessThan(40);
        // First items, a marked gap, the last item, and everything outside the run.
        expect(lines[0]).toContain("Listings");
        expect(lines[1]).toContain('main/ul/li/h3 <h3> "Flat 0"');
        expect(outline.text).toMatch(
            /… blocks (\d+) to 798 not shown: \d+ more like the ones above\. list_blocks shows them\./,
        );
        expect(outline.text).toContain('main/ul/li[400]/p <p> "€1299 a month"');
        expect(lines.at(-1)).toContain("© Acme");
        expect(outline.hidden).toBeGreaterThan(700);
        expect(outline.hidden).toBe(
            rows.length - lines.filter(l => l.startsWith("[")).length,
        );
    });

    it("stops a page that is long without repeating, and says where", () => {
        const many = Array.from({ length: 900 }, (_, i) =>
            block(
                i,
                `${MAIN}/div[${i + 1}]/section[1]/p[1]`,
                `Paragraph ${i}`,
                [0, i * 20, 800, 20],
            ),
        );
        // Each block sits in its own differently-shaped wrapper only by index, so runs do shorten...
        const outline = renderOutline(many, 50);
        expect(outline.text.split("\n").length).toBeLessThanOrEqual(51);
        expect(outline.hidden).toBeGreaterThan(800);
    });
});

describe("the plan's guards", () => {
    const section = (over: Record<string, unknown> = {}) => ({
        name: "Pricing table",
        how: "text",
        why: "You asked about prices.",
        blocks: [[2, 8]],
        ...over,
    });
    const submit = (sections: unknown[], over: Record<string, unknown> = {}) =>
        buildPlan(
            blocks,
            { sections, rest: "text", summary: "Watching prices.", ...over },
            null,
        );

    it("turns index ranges and outline paths into Section paths", () => {
        const built = submit([
            section(),
            {
                name: "Hero image",
                how: "visual",
                why: "You asked about the look.",
                blocks: [[0, 1]],
            },
            {
                name: "Testimonials",
                how: "ignore",
                why: "They rotate.",
                path: "main/section[2]",
            },
            {
                name: "Fine print",
                how: "ignore",
                why: "Dates change daily.",
                blocks: [[12, 12]],
            },
        ]);
        expect(built).toEqual({
            ok: true,
            rest: "text",
            summary: "Watching prices.",
            sections: [
                {
                    id: "pricing-table",
                    name: "Pricing table",
                    how: "text",
                    why: "You asked about prices.",
                    paths: [`${MAIN}/section[1]`],
                },
                {
                    id: "hero-image",
                    name: "Hero image",
                    how: "visual",
                    why: "You asked about the look.",
                    paths: [`${MAIN}/div[1]`],
                },
                {
                    id: "testimonials",
                    name: "Testimonials",
                    how: "ignore",
                    why: "They rotate.",
                    paths: [`${MAIN}/section[2]`],
                },
                {
                    id: "fine-print",
                    name: "Fine print",
                    how: "ignore",
                    why: "Dates change daily.",
                    paths: [`${MAIN}/p[2]`],
                },
            ],
        });
    });

    it("rejects a Section that matches no block", () => {
        expect(submit([section({ blocks: undefined })])).toEqual({
            ok: false,
            problems: [
                'sections[0] ("Pricing table") matches no block: give blocks as [first, last] index ranges from the outline, or a path copied from it',
            ],
        });
        expect(submit([section({ blocks: [[40, 45]] })])).toMatchObject({
            ok: false,
            problems: [
                'sections[0] ("Pricing table"): the block range [40, 45] is not valid (blocks run from 0 to 13)',
            ],
        });
        expect(
            submit([
                section({ blocks: undefined, path: "//div[@class='pricing']" }),
            ]),
        ).toMatchObject({
            ok: false,
            problems: [
                expect.stringContaining("no block is at or under the path"),
            ],
        });
    });

    it("rejects a how that is not one of the four values", () => {
        expect(submit([section({ how: "watch-closely" })])).toEqual({
            ok: false,
            problems: [
                'sections[0] ("Pricing table"): how must be one of text, visual, both, ignore, not "watch-closely"',
            ],
        });
        expect(submit([section()], { rest: "everything" })).toMatchObject({
            ok: false,
            problems: ["rest must be one of text, visual, both, ignore"],
        });
    });

    it("rejects more than 24 Sections", () => {
        const many = Array.from({ length: 25 }, (_, i) =>
            section({ name: `Part ${i}`, blocks: [[i % 14, i % 14]] }),
        );
        const built = submit(many);
        expect(built.ok).toBe(false);
        expect(!built.ok && built.problems[0]).toBe(
            "a plan may hold at most 24 Sections and this one has 25: merge Sections that are watched the same way",
        );
    });

    it("rejects two Sections on the same element, and missing words", () => {
        expect(submit([section(), section({ name: "Plans" })])).toMatchObject({
            ok: false,
            problems: [
                'Sections "Pricing table" and "Plans" both cover main/section: give each its own blocks, or merge them',
            ],
        });
        expect(
            submit([section({ name: " ", why: "" })], { summary: "" }),
        ).toMatchObject({
            ok: false,
            problems: [
                "summary is empty",
                "sections[0] has no name",
                "sections[0] has no why",
            ],
        });
    });

    it("keeps a Section's id from the previous plan and makes new ids unique", () => {
        const previous = {
            sections: [
                {
                    id: "prices",
                    name: "Pricing table",
                    how: "text",
                    why: "",
                    paths: [`${MAIN}/section[1]`],
                },
            ],
        } as unknown as WatchPlan;
        const built = buildPlan(
            blocks,
            {
                sections: [
                    section(),
                    {
                        id: "Hero!",
                        name: "Hero",
                        how: "visual",
                        why: "w",
                        blocks: [[0, 0]],
                    },
                    {
                        id: "hero",
                        name: "Hero line",
                        how: "text",
                        why: "w",
                        blocks: [[1, 1]],
                    },
                ],
                rest: "ignore",
                summary: "s",
            },
            previous,
        );
        expect(built.ok && built.sections.map(s => s.id)).toEqual([
            "prices",
            "hero",
            "hero-2",
        ]);
    });
});

describe("the plan job", () => {
    let provider: FakeProvider;
    let objects: MemoryStore;
    let db: FakeStore;
    let request: PlanRequest;

    const goodPlan = {
        sections: [
            {
                name: "Pricing table",
                how: "text",
                why: "You asked about price changes.",
                blocks: [[2, 8]],
            },
            {
                name: "Hero image",
                how: "visual",
                why: "You asked about a new look.",
                blocks: [[0, 1]],
            },
            {
                name: "Testimonials",
                how: "ignore",
                why: "They rotate and you did not ask about them.",
                path: "main/section[2]",
            },
        ],
        rest: "text",
        summary:
            "Watching the plan cards for price changes and the hero for a new look. Ignoring testimonials.",
    };

    beforeAll(async () => {
        provider = await FakeProvider.start();
    });
    afterAll(() => provider.close());

    beforeEach(async () => {
        provider.reset();
        objects = new MemoryStore();
        db = new FakeStore();
        db.connection = {
            id: "c1",
            kind: "openai",
            name: "Fake",
            baseUrl: provider.baseUrl,
            apiKey: "sk-test-000000000000",
            model: "test-model",
        };
        // Taller than one tile, with an image where the outline has no text.
        const shot = await drawPng(800, 2400, [
            { rect: [440, 20, 340, 240], color: "#2266dd" },
        ]);
        request = {
            run_id: RUN_ID,
            monitor_id: MONITOR_ID,
            user_id: "user-1",
            monitor: {
                name: "Acme pricing",
                url: "https://acme.test/pricing",
                instructions:
                    "Tell me about price changes and a new hero image. Ignore testimonials.",
            },
            connection_id: null,
            model: null,
            capture: await storeCapture(
                objects,
                MONITOR_ID,
                RUN_ID,
                blocks,
                shot,
            ),
            size: [800, 2400],
            previous: null,
            load: null,
        };
    });

    const deps = () => ({
        store: db,
        objectStore: objects,
        logger: silentLogger,
    });

    it("shows the model the Instructions, the outline and the screenshot, and returns the plan", async () => {
        provider.queue({
            calls: [{ name: "submit_plan", input: goodPlan }],
            usage: { input: 3000, output: 200 },
        });
        const response = await plan(deps(), request);

        expect(response).toEqual({
            sections: [
                {
                    id: "pricing-table",
                    name: "Pricing table",
                    how: "text",
                    why: "You asked about price changes.",
                    paths: [`${MAIN}/section[1]`],
                },
                {
                    id: "hero-image",
                    name: "Hero image",
                    how: "visual",
                    why: "You asked about a new look.",
                    paths: [`${MAIN}/div[1]`],
                },
                {
                    id: "testimonials",
                    name: "Testimonials",
                    how: "ignore",
                    why: "They rotate and you did not ask about them.",
                    paths: [`${MAIN}/section[2]`],
                },
            ],
            rest: "text",
            summary: goodPlan.summary,
            model: "test-model",
            input_tokens: 3000,
            output_tokens: 200,
            steps: 1,
        });

        const body = provider.requests[0]!.body as LooseJson;
        const system: string = body.messages[0].content;
        const first = body.messages[1].content as LooseJson[];
        const firstText: string = first[0]!.text;
        const tag = /<(page-data-[0-9a-f]{8})>/.exec(system)?.[1];
        expect(system).toContain("3 to 10 Sections is typical");
        expect(system).not.toContain("Acme");
        expect(firstText).toContain(
            'The owner\'s Instructions:\n"""\nTell me about price changes',
        );
        expect(firstText).toContain("The page's outline: 14 blocks.");
        expect(firstText).toContain(
            `<${tag} what="outline">\n[0] main/div/h1 <h1> "Ship faster with Acme" (20,20,400,40)`,
        );
        expect(firstText).not.toContain("The Watch Plan being replaced");

        // The tall screenshot arrives as two tiles, each saying which part of the page it shows.
        const labels = first
            .filter(p => p.type === "text")
            .map(p => p.text as string)
            .slice(1);
        expect(labels).toEqual([
            "The screenshot (800×2400 pixels), part 1 of 2: page y from 0 to 1200, scaled to 100%:",
            "The screenshot (800×2400 pixels), part 2 of 2: page y from 1200 to 2400, scaled to 100%:",
        ]);
        expect(first.filter(p => p.type === "image_url")).toHaveLength(2);
        expect(
            body.tools.map(
                (t: { function: { name: string } }) => t.function.name,
            ),
        ).toEqual(["view_region", "read_block", "list_blocks", "submit_plan"]);

        expect(
            db
                .trace(RUN_ID)
                .map(s => [s.phase, s.kind, s.status, s.title, s.inputTokens]),
        ).toEqual([
            ["plan", "submit_plan", "ok", `Planned: ${goodPlan.summary}`, 3000],
        ]);
    });

    it("lets the model look closer, and sends back a plan that does not fit the page", async () => {
        provider.queue(
            {
                calls: [
                    {
                        name: "view_region",
                        input: {
                            box: [440, 20, 340, 240],
                            looking_at: "the image next to the headline",
                        },
                    },
                    { name: "read_block", input: { index: 10, neighbours: 1 } },
                    { name: "list_blocks", input: { path: "main/section" } },
                ],
                usage: { input: 2000, output: 100 },
            },
            {
                calls: [
                    {
                        name: "submit_plan",
                        input: {
                            ...goodPlan,
                            sections: [
                                {
                                    name: "Sidebar",
                                    how: "text",
                                    why: "w",
                                    path: "main/aside",
                                },
                            ],
                        },
                    },
                ],
                usage: { input: 2500, output: 100 },
            },
            {
                calls: [{ name: "submit_plan", input: goodPlan }],
                usage: { input: 2700, output: 150 },
            },
        );
        const response = await plan(deps(), request);
        expect(response).toMatchObject({
            steps: 3,
            input_tokens: 7200,
            output_tokens: 350,
        });
        expect(response.sections).toHaveLength(3);

        const afterTools = provider.requests[1]!;
        expect(afterTools.lastText).toContain(
            "The screenshot at x=440 y=20 w=340 h=240:",
        );
        expect(afterTools.lastText).toContain(
            '> [10] main/section[2]/blockquote <blockquote> "Acme changed how we work."',
        );
        expect(afterTools.lastText).toContain(
            '[8] main/section/div[3]/p <p> "$99 a month" (520,360,240,20)',
        );
        expect(afterTools.lastText).not.toContain(
            'What customers say" (20,420,760,30)\n[10]',
        );
        expect(provider.requests[2]!.lastText).toContain(
            'The plan was not accepted:\n- sections[0] ("Sidebar"): no block is at or under the path "main/aside".',
        );

        expect(db.trace(RUN_ID).map(s => [s.kind, s.status, s.title])).toEqual([
            [
                "view_region",
                "ok",
                "Looked at the image next to the headline in the screenshot",
            ],
            ["read_block", "ok", "Read block 10 and the text around it"],
            ["list_blocks", "ok", "Listed the blocks under main/section"],
            [
                "submit_plan",
                "failed",
                "Plan sent back: it did not fit the page",
            ],
            ["submit_plan", "ok", `Planned: ${goodPlan.summary}`],
        ]);
    });

    it("shows the previous plan, asks to keep ids, and to keep what the owner set by hand", async () => {
        const previous: WatchPlan = {
            version: 1,
            sections: [
                {
                    id: "prices",
                    name: "Pricing table",
                    how: "both",
                    why: "Set by the owner.",
                    paths: [`${MAIN}/section[1]`],
                },
            ],
            rest: "ignore",
            summary: "Only prices.",
            instructions_hash: "h",
            run_id: RUN_ID,
            model: "",
            created_at: "2026-11-01T00:00:00Z",
        };
        provider.queue({
            calls: [
                {
                    name: "submit_plan",
                    input: {
                        ...goodPlan,
                        sections: [{ ...goodPlan.sections[0], how: "both" }],
                    },
                },
            ],
        });
        const response = await plan(deps(), { ...request, previous });

        const firstText: string = (provider.requests[0]!.body as LooseJson)
            .messages[1].content[0].text;
        expect(firstText).toContain(
            "The Watch Plan being replaced was last edited by the owner:",
        );
        expect(firstText).toContain(
            '- id "prices", "Pricing table", watched as both, at main/section. Set by the owner.',
        );
        expect(firstText).toContain(
            "Where a Section is still on the page, give it the same id.",
        );
        expect(firstText).toContain(
            "The owner chose how these Sections are watched: keep each Section's how as it is",
        );
        // The id carries over by name even though the model did not repeat it.
        expect(response.sections[0]).toMatchObject({
            id: "prices",
            how: "both",
        });

        provider.queue({ calls: [{ name: "submit_plan", input: goodPlan }] });
        await plan(deps(), {
            ...request,
            previous: { ...previous, model: "some-model" },
        });
        const again: string = (provider.requests[1]!.body as LooseJson)
            .messages[1].content[0].text;
        expect(again).toContain("The Watch Plan being replaced:");
        expect(again).not.toContain("The owner chose how");
    });

    it("plans from the outline alone when there is no screenshot, and fails without blocks", async () => {
        provider.queue({ calls: [{ name: "submit_plan", input: goodPlan }] });
        await plan(deps(), {
            ...request,
            capture: { ...request.capture, screenshot: "" },
            size: [0, 0],
        });
        const first = (provider.requests[0]!.body as LooseJson).messages[1]
            .content as LooseJson[];
        expect(first.filter(p => p.type === "image_url")).toHaveLength(0);
        expect(first.at(-1)!.text).toContain("no stored screenshot");

        const failure = await plan(deps(), {
            ...request,
            capture: { ...request.capture, blocks: "" },
        }).catch(e => e);
        expect(failure).toBeInstanceOf(AgentJobError);
        expect(failure.code).toBe("not_found");
    });
});
