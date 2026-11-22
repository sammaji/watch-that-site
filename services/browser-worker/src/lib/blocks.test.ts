import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchPool } from "../testing/harness.js";
import { extractBlocks, pageSize } from "./blocks.js";
import type { BrowserPool, BrowserPoolContextLease } from "./browser-pool.js";

const fixture = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px/20px sans-serif; }
  p, h1, ul, li { margin: 0; padding: 0; }
  #intro { height: 60px; }
</style></head><body>
<main>
  <h1 style="height:40px">Pricing</h1>
  <div id="intro">Intro text<p>Child para</p></div>
  <ul><li>One</li><li><p>Wrapped</p></li></ul>
  <div><span>Price</span> <b>$49</b></div>
  <p>Buy <button>now</button></p>
  <p style="display:none">Hidden display</p>
  <p style="visibility:hidden">Hidden visibility</p>
  <div style="visibility:hidden"><p style="visibility:visible">Visible child</p></div>
  <p aria-hidden="true">Hidden aria</p>
  <div aria-hidden="true"><p>Hidden aria child</p></div>
  <p style="width:0;height:0;overflow:hidden">Zero size</p>
  <span style="display:block">Block span</span>
  <p>   </p>
  <script>var ignored = "script text";</script>
  <p>Spaced
       out     text</p>
</main>
</body></html>`;

let pool: BrowserPool;
let lease: BrowserPoolContextLease;
let page: Page;

beforeAll(async () => {
    pool = await launchPool();
    lease = await pool.acquire();
    page = await lease.context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
});

afterAll(async () => {
    await lease?.release();
    await pool?.close();
});

describe("extractBlocks", () => {
    it("emits one block per visible block-level element, without double counting", async () => {
        await page.setContent(fixture);
        const result = await extractBlocks(page);

        expect(result).not.toBeNull();
        expect(result.truncated).toBe(false);
        expect(result.blocks.map(b => [b.id, b.tag, b.text])).toEqual([
            ["b0", "h1", "Pricing"],
            ["b1", "div", "Intro text"],
            ["b2", "p", "Child para"],
            ["b3", "li", "One"],
            // The li wrapping a p has no text of its own and is dropped.
            ["b4", "p", "Wrapped"],
            ["b5", "div", "Price $49"],
            ["b6", "p", "Buy"],
            ["b7", "button", "now"],
            ["b8", "p", "Visible child"],
            ["b9", "span", "Block span"],
            ["b10", "p", "Spaced out text"],
        ]);
    });

    it("gives every block an absolute XPath that resolves back to it", async () => {
        await page.setContent(fixture);
        const { blocks } = await extractBlocks(page);

        expect(blocks[0]!.path).toBe("/html[1]/body[1]/main[1]/h1[1]");
        expect(blocks[1]!.path).toBe("/html[1]/body[1]/main[1]/div[1]");
        expect(blocks[2]!.path).toBe("/html[1]/body[1]/main[1]/div[1]/p[1]");
        expect(blocks[4]!.path).toBe(
            "/html[1]/body[1]/main[1]/ul[1]/li[2]/p[1]",
        );

        // A Watch Plan roots its Sections at these paths, so each must name
        // exactly one element.
        const counts = await page.evaluate(
            paths =>
                paths.map(
                    p =>
                        document.evaluate(
                            p,
                            document,
                            null,
                            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                            null,
                        ).snapshotLength,
                ),
            blocks.map(b => b.path),
        );
        expect(counts.every(c => c === 1)).toBe(true);
    });

    it("reports rects in page coordinates", async () => {
        await page.setContent(fixture);
        const result = await extractBlocks(page);
        const [h1, intro] = result.blocks;

        expect(h1!.rect).toEqual([0, 0, 800, 40]);
        expect(intro!.rect).toEqual([0, 40, 800, 60]);
    });

    it("reports the document's extent", async () => {
        await page.setContent(
            `<body style="margin:0"><div style="height:1500px">Tall</div></body>`,
        );
        expect(await pageSize(page)).toEqual({ w: 800, h: 1500 });
    });

    it("returns no blocks for a page without text", async () => {
        await page.setContent(`<body><div style="height:50px"></div></body>`);
        expect(await extractBlocks(page)).toEqual({
            blocks: [],
            truncated: false,
        });
    });

    it("keeps pictures, charts and embeds as blocks with empty text", async () => {
        const pixel =
            "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
        await page.setContent(`<body style="margin:0">
          <main>
            <div id="hero" style="height:200px;background-image:url(${pixel})">
              <h1 style="margin:0;height:40px">Ship faster</h1>
            </div>
            <img id="photo" src="${pixel}" alt="Team photo" style="display:block;width:300px;height:150px">
            <img id="icon" src="${pixel}" style="display:block;width:16px;height:16px">
            <picture><img id="art" src="${pixel}" style="display:block;width:100px;height:100px"></picture>
            <svg id="chart" width="200" height="100" style="display:block"><text x="0" y="20">Revenue</text></svg>
            <canvas id="plot" width="120" height="60" style="display:block"></canvas>
            <video id="clip" style="display:block;width:160px;height:90px"></video>
            <iframe id="map" srcdoc="<p>Map</p>" style="display:block;width:200px;height:100px;border:0"></iframe>
            <div aria-hidden="true"><img id="deco" src="${pixel}" style="display:block;width:80px;height:80px"><p>Not read aloud</p></div>
            <img id="gone" src="${pixel}" style="display:none;width:300px;height:150px">
            <p style="margin:0">Caption with <img src="${pixel}" style="width:60px;height:60px;vertical-align:top"> inside</p>
            <div id="gradient" style="height:80px;background-image:linear-gradient(red,blue)"></div>
          </main>
        </body>`);
        const { blocks } = await extractBlocks(page);

        expect(blocks.map(b => [b.tag, b.text, b.rect.slice(2)])).toEqual([
            ["div", "", [800, 200]], // the hero's background, around its headline
            ["h1", "Ship faster", [800, 40]],
            ["img", "", [300, 150]],
            ["img", "", [100, 100]], // inside <picture>
            ["svg", "", [200, 100]],
            ["canvas", "", [120, 60]],
            ["video", "", [160, 90]],
            ["iframe", "", [200, 100]],
            ["img", "", [80, 80]], // decorative, but on the screenshot all the same
            ["p", "Caption with inside", [800, 60]],
            ["img", "", [60, 60]],
        ]);
        // Paths place them in the page like any other block.
        expect(blocks[0]!.path).toBe("/html[1]/body[1]/main[1]/div[1]");
        expect(blocks[3]!.path).toBe(
            "/html[1]/body[1]/main[1]/picture[1]/img[1]",
        );
        expect(blocks[4]!.path).toBe("/html[1]/body[1]/main[1]/svg[1]");
        expect(blocks.map(b => b.id)).toEqual(blocks.map((_, i) => `b${i}`));
    });

    it("reads the text around a picture exactly as it would without it", async () => {
        const pixel =
            "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
        const html = (img: string) =>
            `<body><p style="text-transform:uppercase">Buy ${img} now</p><div>Plan <span>Pro</span>${img}<p>Details</p></div></body>`;
        await page.setContent(html(""));
        const without = (await extractBlocks(page)).blocks.map(b => b.text);
        await page.setContent(
            html(`<img src="${pixel}" style="width:60px;height:60px">`),
        );
        const withPictures = (await extractBlocks(page)).blocks;
        expect(
            withPictures.filter(b => b.text !== "").map(b => b.text),
        ).toEqual(without);
        expect(without).toEqual(["BUY NOW", "Plan Pro", "Details"]);
        expect(withPictures.filter(b => b.text === "")).toHaveLength(2);
    });

    it("caps the block count and sets truncated", async () => {
        const items = Array.from(
            { length: 30 },
            (_, i) => `<p>Item ${i}</p>`,
        ).join("");
        await page.setContent(`<body>${items}</body>`);

        const byCount = await extractBlocks(page, {
            maxBlocks: 10,
            maxChars: 1_000_000,
        });
        expect(byCount.blocks).toHaveLength(10);
        expect(byCount.truncated).toBe(true);

        // "Item 0".."Item 9" are 6 chars each; 20 chars fit three blocks.
        const byChars = await extractBlocks(page, {
            maxBlocks: 1000,
            maxChars: 20,
        });
        expect(byChars.blocks.map(b => b.text)).toEqual([
            "Item 0",
            "Item 1",
            "Item 2",
        ]);
        expect(byChars.truncated).toBe(true);

        const all = await extractBlocks(page);
        expect(all.blocks).toHaveLength(30);
        expect(all.truncated).toBe(false);
    });
});
