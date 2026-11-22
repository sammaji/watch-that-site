import type { SuggestRequest, SuggestResponse } from "@watchthatsite/types";
import sharp from "sharp";
import type { BlockerProvider } from "../lib/blocking.js";
import type { BrowserPool } from "../lib/browser-pool.js";
import { openMonitorPage } from "../macro/session.js";
import {
    adapterOf,
    AgentJobError,
    stopMessage,
    type AgentDeps,
} from "./job.js";
import { runAgent, type AgentTool } from "./loop.js";
import { clip, PageData } from "./page-data.js";
import { text, type ContentPart } from "./types.js";

/**
 * Suggestions for a Monitor that is still being created: a few Instructions
 * that fit the page the owner typed in. Its name is the page's title.
 *
 * The page is opened in a browser, as a Run would see it, so a page built by
 * scripts is read as rendered rather than as its empty HTML shell. The
 * owner's utility model (a small, cheap model by default) reads the title,
 * the visible text and one screenshot, and answers once through a tool.
 */

/** How much of the page's text the model reads. */
const TEXT_CHARS = 8_000;
const LIMITS = { maxSteps: 3, wallClockMs: 60_000 };

type Answer = { suggestions: string[] };

export async function suggest(
    deps: AgentDeps & { pool: BrowserPool; blockers: BlockerProvider },
    req: SuggestRequest,
): Promise<SuggestResponse> {
    const choice = await deps.store.utilityModel(req.user_id);
    const connection = await deps.store.resolveConnection({
        userId: req.user_id,
        ...choice,
    });
    const log = deps.logger.child({ job: "suggest" });

    let title = "";
    let body = "";
    let shot: Buffer | null = null;
    const live = await openMonitorPage(
        { pool: deps.pool, blockers: deps.blockers, logger: log },
        {
            url: req.url,
            viewportW: 1366,
            viewportH: 900,
            blockAds: true,
            extraWaitMs: 0,
        },
    ).catch(err => {
        throw new AgentJobError(
            "bad_request",
            `The page could not be opened: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`,
        );
    });
    try {
        ({ title, body } = await live.page.evaluate(() => ({
            title: document.title,
            body: document.body?.innerText ?? "",
        })));
        await live.page.evaluate(() => window.scrollTo(0, 0));
        const png = await live.page.screenshot({ type: "png" });
        shot = await sharp(png)
            .resize({ width: 1024, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();
    } finally {
        await live.close();
    }

    const pageData = new PageData();
    const first: ContentPart[] = [
        text(
            [
                `URL: ${req.url}`,
                `Title: ${clip(title, 200)}`,
                "",
                "The page's visible text, from the top:",
                pageData.wrap(
                    "page-text",
                    clip(body.replace(/\n{3,}/g, "\n\n").trim(), TEXT_CHARS),
                ),
            ].join("\n"),
        ),
    ];
    if (shot) {
        first.push(text("The top of the page as it looks:"), {
            type: "image",
            mediaType: "image/jpeg",
            data: shot,
        });
    }

    const submit: AgentTool<Answer> = {
        def: {
            name: "suggest",
            description: "Give the suggested Instructions.",
            inputSchema: {
                type: "object",
                required: ["suggestions"],
                properties: {
                    suggestions: {
                        type: "array",
                        minItems: 3,
                        maxItems: 4,
                        items: { type: "string" },
                        description:
                            "Instructions the owner could give, each one sentence.",
                    },
                },
            },
        },
        async run(input) {
            const suggestions = (input.suggestions as unknown[])
                .map(s => String(s).trim())
                .filter(s => s.length > 0 && s.length <= 200);
            if (suggestions.length < 3) {
                return {
                    isError: true,
                    content: [
                        text(
                            "Give 3 or 4 suggestions, each one sentence of at most 200 characters.",
                        ),
                    ],
                };
            }
            return {
                content: [text("Thanks.")],
                result: { suggestions: suggestions.slice(0, 4) },
            };
        },
    };

    const run = await runAgent<Answer>({
        adapter: adapterOf(deps, connection),
        system: `You help someone set up a Monitor in WatchThatSite, a service that checks a web page on a schedule and tells its owner when something they care about changes. They have typed in a URL; you see the page. Suggest 3 or 4 Instructions they might give.

Instructions are written in the owner's voice and say what to be told about and, where it helps, what to ignore: "Tell me when the price of the Team plan changes.", "Tell me when a new role is posted in Engineering; ignore ones that are removed.", "Tell me about any change to the refund terms; ignore the date in the footer."

Make each suggestion specific to this page: name the actual things on it (the plans, the product, the section, the table) rather than generic ones. Cover different reasons someone would watch this page. Prefer changes that matter to a person over cosmetic ones, and where the page has obvious noise (a rotating banner, a "last updated" line, a visitor counter), a suggestion may say to ignore it. Refer to things by name, not by their current values ("the Team plan's price", not "the $89 price"), since the values are what will change. One short sentence each, at most about 15 words, plain words, no quotes.

${pageData.rule}

Answer by calling suggest once.`,
        tools: [submit],
        first,
        limits: LIMITS,
        finishHint: "call suggest",
    });
    if (!run.result) {
        throw new AgentJobError(
            "provider_error",
            stopMessage(run.stopped, run.steps),
        );
    }
    log.info({ steps: run.steps, usage: run.usage }, "[suggest] answered");
    return {
        ...run.result,
        title: clip(title, 200),
        model: run.model,
        input_tokens: run.usage.inputTokens,
        output_tokens: run.usage.outputTokens,
    };
}
