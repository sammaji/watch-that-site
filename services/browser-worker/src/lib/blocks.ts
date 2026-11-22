import type { Block } from "@watchthatsite/types";
import type { Page } from "playwright-core";

/** Caps mirrored from the scheduler's capture.MaxBlocks / MaxBlockChars. */
export const maxBlocks = 5000;
export const maxBlockChars = 200_000;

export type BlocksResult = {
    blocks: Block[];
    truncated: boolean;
};

type EvalArgs = {
    maxBlocks: number;
    maxChars: number;
    minVisualSide: number;
    minVisualArea: number;
};

type RawBlock = Omit<Block, "id">;

type EvalResult = {
    blocks: RawBlock[];
    truncated: boolean;
};

/** The document's own extent in CSS pixels: what a full-page screenshot covers. */
export async function pageSize(page: Page): Promise<{ w: number; h: number }> {
    return page.evaluate(() => {
        const doc = document.documentElement;
        return {
            w: Math.max(doc.scrollWidth, doc.clientWidth),
            h: Math.max(doc.scrollHeight, doc.clientHeight),
        };
    });
}

/** A picture, chart or embed smaller than this on either count is an icon, not content. */
export const minVisualSide = 24;
export const minVisualArea = 48 * 48;

/**
 * Walks the page in document order and emits one block per visible
 * block-level element, in a single `page.evaluate`.
 *
 * Which elements are text blocks:
 * - block tags, always: `p`, `li`, `h1`–`h6`, `td`, `th`, `dd`, `dt`,
 *   `blockquote`, `pre`, `figcaption`, `caption`, `label`, `button`,
 *   `summary`, `legend`;
 * - any other element whose computed display is not inline-level (`div`,
 *   `section`, `article`, a `span` or `a` with `display: block`, flex items,
 *   custom elements, ...) that has inline-level text of its own: a non-blank
 *   text node, or an inline child with text (`<div><span>$49</span></div>`).
 *   Inline-level elements (`inline`, `inline-block`, ...) are never blocks on
 *   their own; their text belongs to the enclosing block.
 *
 * Hidden elements are skipped: `display: none` and `aria-hidden="true"` prune
 * the whole subtree; `visibility: hidden` and zero-size elements are not
 * emitted themselves, but their descendants are still visited (a child may
 * be `visibility: visible`, or overflow a zero-size wrapper).
 *
 * Text and nesting: a block that contains no other emitted block takes its
 * `innerText`. A block that does (a `div` with direct text plus child `p`s, an
 * `li` wrapping a `p`) takes only its *own* text: its text nodes and the
 * rendered text of descendants that are not themselves blocks, with every
 * nested block's subtree left out. So each piece of text lands in exactly one
 * block, and a wrapper whose own text is empty is dropped. Whitespace is
 * collapsed to single spaces.
 *
 * Visual blocks: content that has a place on the page but no words is kept
 * too, as a block with empty text: an `img`, `svg`, `canvas`, `video`,
 * `iframe`, `object` or `embed`, and any element with a CSS background image,
 * when it is visible and at least icon-sized (`minVisualSide`,
 * `minVisualArea`). A Watch Plan can then root a Section watched for its
 * look on a hero image or a chart, and the Section's rectangle (the area
 * around its blocks) covers the picture and not just its caption. Visual
 * blocks never change the text of the blocks around them, and unlike text
 * they are kept inside `aria-hidden` subtrees: a decorative image is hidden
 * from screen readers, not from the screenshot.
 *
 * Paths are absolute XPaths (`/html[1]/body[1]/main[1]/p[2]`); a Watch Plan
 * roots its Sections at them. Rects are `[x, y, w, h]` in page coordinates,
 * which are also the full-page screenshot's pixels.
 */
export async function extractBlocks(
    page: Page,
    caps: { maxBlocks: number; maxChars: number } = {
        maxBlocks,
        maxChars: maxBlockChars,
    },
): Promise<BlocksResult> {
    const args: EvalArgs = {
        maxBlocks: caps.maxBlocks,
        maxChars: caps.maxChars,
        minVisualSide,
        minVisualArea,
    };

    const result: EvalResult = await page.evaluate(
        ({ maxBlocks, maxChars, minVisualSide, minVisualArea }): EvalResult => {
            const BLOCK_TAGS = new Set([
                "P",
                "LI",
                "H1",
                "H2",
                "H3",
                "H4",
                "H5",
                "H6",
                "TD",
                "TH",
                "DD",
                "DT",
                "BLOCKQUOTE",
                "PRE",
                "FIGCAPTION",
                "CAPTION",
                "LABEL",
                "BUTTON",
                "SUMMARY",
                "LEGEND",
            ]);
            const SKIP_TAGS = new Set([
                "SCRIPT",
                "STYLE",
                "NOSCRIPT",
                "TEMPLATE",
                "HEAD",
                "META",
                "LINK",
                "AUDIO",
                "SELECT",
                "TEXTAREA",
                "INPUT",
            ]);
            // Content with a look and no words. Never descended into, and
            // never part of a text block's text.
            const VISUAL_TAGS = new Set([
                "IMG",
                "SVG",
                "CANVAS",
                "VIDEO",
                "IFRAME",
                "OBJECT",
                "EMBED",
            ]);
            const noText = (tag: string) =>
                SKIP_TAGS.has(tag) || VISUAL_TAGS.has(tag);

            // The absolute XPath, with an index on every step.
            function getFullXPath(element: Element): string {
                const parts: string[] = [];
                let current: Element | null = element;
                while (current && current.nodeType === Node.ELEMENT_NODE) {
                    let index = 1;
                    let sibling = current.previousElementSibling;
                    while (sibling) {
                        if (sibling.tagName === current.tagName) index += 1;
                        sibling = sibling.previousElementSibling;
                    }
                    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
                    current = current.parentElement;
                }
                return `/${parts.join("/")}`;
            }

            const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

            const isInlineDisplay = (display: string) =>
                display.startsWith("inline") || display === "contents";

            // Whether the element has text of its own at inline level: a
            // non-blank text node, or an inline-level child (not itself a
            // block tag) with text, such as `<div><span>$49</span></div>`.
            function hasInlineText(el: Element): boolean {
                for (const child of el.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        if ((child.nodeValue ?? "").trim() !== "") return true;
                        continue;
                    }
                    if (!(child instanceof Element)) continue;
                    const tag = child.tagName.toUpperCase();
                    if (noText(tag) || BLOCK_TAGS.has(tag)) continue;
                    if (child.getAttribute("aria-hidden") === "true") continue;
                    if (
                        isInlineDisplay(getComputedStyle(child).display) &&
                        (child.textContent ?? "").trim() !== ""
                    ) {
                        return true;
                    }
                }
                return false;
            }

            if (!document.body) return { blocks: [], truncated: false };
            const body: Element = document.body;

            // Pass 1: decide which elements are blocks, in document order.
            const emitted: Element[] = [];
            // Text blocks, and elements with at least one text block below
            // them. Visual blocks are in neither, so they never change how
            // the text around them is read.
            const isBlock = new Set<Element>();
            const hasNested = new Set<Element>();
            // Elements that are worth a block for their look alone.
            const visual = new Set<Element>();

            const bigEnough = (r: DOMRect) =>
                r.width >= minVisualSide &&
                r.height >= minVisualSide &&
                r.width * r.height >= minVisualArea;

            // `silent`: inside an aria-hidden subtree, where text is not
            // read but pictures still count.
            function visit(el: Element, silent: boolean): void {
                const tag = el.tagName.toUpperCase();
                if (SKIP_TAGS.has(tag)) return;
                const style = getComputedStyle(el);
                if (style.display === "none") return;

                if (VISUAL_TAGS.has(tag)) {
                    if (
                        style.visibility !== "hidden" &&
                        bigEnough(el.getBoundingClientRect())
                    ) {
                        visual.add(el);
                        emitted.push(el);
                    }
                    return;
                }

                const quiet =
                    silent || el.getAttribute("aria-hidden") === "true";
                const shown = style.visibility !== "hidden";
                const candidate =
                    !quiet &&
                    (BLOCK_TAGS.has(tag) ||
                        ((el === body || !isInlineDisplay(style.display)) &&
                            hasInlineText(el)));
                const pictured =
                    el !== body && style.backgroundImage.includes("url(");

                if (shown && (candidate || pictured)) {
                    const r = el.getBoundingClientRect();
                    const textBlock = candidate && r.width > 0 && r.height > 0;
                    if (textBlock) {
                        isBlock.add(el);
                        for (
                            let p = el.parentElement;
                            p && p !== body.parentElement;
                            p = p.parentElement
                        ) {
                            if (hasNested.has(p)) break;
                            hasNested.add(p);
                        }
                    }
                    if (pictured && bigEnough(r)) visual.add(el);
                    if (textBlock || visual.has(el)) emitted.push(el);
                }

                for (const child of el.children) visit(child, quiet);
            }
            visit(body, false);

            // The text of a block that contains other blocks: its own text
            // nodes plus the rendered text of non-block descendants, skipping
            // nested blocks entirely.
            function ownText(el: Element, out: string[]): void {
                for (const child of el.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const parent = child.parentElement;
                        if (
                            parent &&
                            getComputedStyle(parent).visibility !== "hidden"
                        ) {
                            out.push(child.nodeValue ?? "");
                        }
                        continue;
                    }
                    if (!(child instanceof Element)) continue;
                    if (isBlock.has(child)) {
                        out.push(" ");
                        continue;
                    }
                    if (noText(child.tagName.toUpperCase())) continue;
                    if (child.getAttribute("aria-hidden") === "true") continue;
                    if (hasNested.has(child)) {
                        ownText(child, out);
                    } else if (child instanceof HTMLElement) {
                        out.push(" ", child.innerText, " ");
                    }
                }
            }

            const blocks: RawBlock[] = [];
            let chars = 0;
            let truncated = false;
            for (const el of emitted) {
                let text: string;
                if (!isBlock.has(el)) {
                    text = "";
                } else if (hasNested.has(el)) {
                    const parts: string[] = [];
                    ownText(el, parts);
                    text = collapse(parts.join(""));
                } else {
                    text = collapse(
                        el instanceof HTMLElement ?
                            el.innerText
                        :   (el.textContent ?? ""),
                    );
                }
                // A text block without text is dropped, unless it is also
                // worth keeping for its look.
                if (text === "" && !visual.has(el)) continue;
                if (
                    blocks.length >= maxBlocks ||
                    chars + text.length > maxChars
                ) {
                    truncated = true;
                    break;
                }
                chars += text.length;
                const r = el.getBoundingClientRect();
                blocks.push({
                    path: getFullXPath(el),
                    tag: el.tagName.toLowerCase(),
                    text,
                    rect: [
                        Math.round(r.left + window.scrollX),
                        Math.round(r.top + window.scrollY),
                        Math.round(r.width),
                        Math.round(r.height),
                    ],
                });
            }
            return { blocks, truncated };
        },
        args,
    );

    return {
        blocks: result.blocks.map((b, i) => ({ id: `b${i}`, ...b })),
        truncated: result.truncated,
    };
}
