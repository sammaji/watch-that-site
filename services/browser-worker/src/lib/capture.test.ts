import { PlaywrightBlocker } from "@ghostery/adblocker-playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    deps,
    html,
    launchPool,
    makeJob,
    MemoryStore,
    MONITOR_ID,
    RUN_ID,
    silentLogger,
    startServer,
    type FixtureServer,
} from "../testing/harness.js";
import { createBlockerProvider } from "./blocking.js";
import type { BrowserPool } from "./browser-pool.js";
import { takeCapture } from "./capture.js";
import { storageStateKey } from "./keys.js";

const style = `<style>body{margin:0;font:16px/20px sans-serif} p,h1{margin:0}</style>`;

const staticPage = html(
    `<h1 style="height:40px">Static page</h1>
     <section id="plans" style="margin-top:10px;height:100px;background:#eef">
       <p>Pro plan $49</p><p>Team plan $99</p>
     </section>`,
    `<title>Static</title>${style}`,
);

const animatedPage = html(
    `<p>Animated page</p>
     <canvas id="c" width="200" height="100" style="display:block;margin-top:50px"></canvas>
     <script>
       const ctx = document.getElementById("c").getContext("2d");
       let n = 0;
       setInterval(() => {
         n++;
         ctx.fillStyle = "hsl(" + ((n * 47) % 360) + ",80%,50%)";
         ctx.fillRect(0, 0, 200, 100);
       }, 50);
     </script>`,
    style,
);

let server: FixtureServer;
let pool: BrowserPool;

beforeAll(async () => {
    server = await startServer({
        "/static": staticPage,
        "/animated": animatedPage,
        "/missing": html("<h1>Gone</h1>", "", 404),
        "/redirect": (_req, res) => {
            res.writeHead(302, {
                location: `http://localhost:${server.port}/static`,
            });
            res.end();
        },
        "/same-site-redirect": (_req, res) => {
            res.writeHead(302, { location: "/static" });
            res.end();
        },
        "/challenge-title": html(
            "<p>Checking your browser before accessing the site.</p>",
            "<title>Just a moment...</title>",
        ),
        "/challenge-header": (_req, res) => {
            res.writeHead(403, {
                "content-type": "text/html",
                "cf-mitigated": "challenge",
            });
            res.end("<html><body><p>Blocked</p></body></html>");
        },
        "/empty": html(
            `<div style="height:200px;background:linear-gradient(red,blue)"></div>`,
        ),
        "/pictures-only": html(
            `<canvas width="300" height="200" style="display:block;background:#246"></canvas>`,
        ),
        "/blank": html(
            `<h1>Lots of text</h1>${"<p>A paragraph of real text that should be visible.</p>".repeat(20)}`,
            "<style>html{opacity:0}</style>",
        ),
        "/noise": html(
            `<p>Main content</p>
             <div class="ad-banner">Buy our sponsor's stuff</div>
             <p class="promo">Limited offer</p>`,
            style,
        ),
        "/state": (req, res) => {
            const cookie = req.headers.cookie ?? "none";
            res.writeHead(200, {
                "content-type": "text/html",
                "set-cookie": "visited=yes; Path=/",
            });
            res.end(`<html><body><p>Cookie: ${cookie}</p></body></html>`);
        },
    });
    pool = await launchPool();
});

afterAll(async () => {
    await pool?.close();
    await server?.close();
});

const url = (path: string) => `${server.origin}${path}`;

describe("takeCapture: a valid page", () => {
    it("captures blocks, a stable screenshot and meta", async () => {
        const store = new MemoryStore();
        const capture = await takeCapture(
            deps(pool, store),
            makeJob(url("/static")),
        );

        expect(capture.status).toBe("ok");
        expect(capture.invalid_reason).toBeNull();
        expect(capture.error).toBeNull();
        expect(capture.blocks.map(b => b.text)).toEqual([
            "Static page",
            "Pro plan $49",
            "Team plan $99",
        ]);
        expect(capture.meta).toMatchObject({
            http_status: 200,
            final_url: url("/static"),
            title: "Static",
            stable: true,
            env_version: "2026-11-21.1",
        });
        expect(capture.masks).toEqual([]);
        expect(capture.screenshot).toEqual({
            key: `captures/${MONITOR_ID}/${RUN_ID}/shot.png`,
            w: 800,
            h: 600,
            format: "png",
        });
        expect(store.objects.get(capture.screenshot!.key)?.contentType).toBe(
            "image/png",
        );
        expect(capture.macro).toBeNull();
    });

    it("encodes WebP when asked", async () => {
        const store = new MemoryStore();
        const capture = await takeCapture(
            deps(pool, store),
            makeJob(url("/static"), { capture: { screenshot: "webp" } }),
        );

        expect(capture.screenshot?.format).toBe("webp");
        expect(capture.screenshot?.key).toBe(
            `captures/${MONITOR_ID}/${RUN_ID}/shot.webp`,
        );
        const stored = store.objects.get(capture.screenshot!.key)!;
        expect(stored.contentType).toBe("image/webp");
        expect(Buffer.from(stored.body.subarray(0, 4)).toString()).toBe("RIFF");
    });

    it("follows a same-site redirect", async () => {
        const capture = await takeCapture(
            deps(pool),
            makeJob(url("/same-site-redirect")),
        );
        expect(capture.status).toBe("ok");
        expect(capture.meta.final_url).toBe(url("/static"));
    });
});

describe("takeCapture: two-frame check", () => {
    it("marks an animated page unstable and masks the moving region", async () => {
        const capture = await takeCapture(
            deps(pool),
            makeJob(url("/animated")),
        );

        expect(capture.status).toBe("ok");
        expect(capture.meta.stable).toBe(false);
        expect(capture.masks.length).toBeGreaterThanOrEqual(1);
        // The canvas sits at (0, 70) and is 200x100; every mask is inside
        // the 16 px grid cells covering it.
        for (const [x, y, w, h] of capture.masks) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x + w).toBeLessThanOrEqual(208);
            expect(y).toBeGreaterThanOrEqual(64);
            expect(y + h).toBeLessThanOrEqual(176);
        }
    });

    it("keeps a static page stable", async () => {
        const capture = await takeCapture(deps(pool), makeJob(url("/static")));
        expect(capture.meta.stable).toBe(true);
        expect(capture.masks).toEqual([]);
    });
});

describe("takeCapture: invalid Captures", () => {
    it("http_status", async () => {
        const capture = await takeCapture(deps(pool), makeJob(url("/missing")));
        expect(capture.status).toBe("invalid");
        expect(capture.invalid_reason).toBe("http_status");
        expect(capture.meta.http_status).toBe(404);
        expect(capture.screenshot).toBeNull();
    });

    it("cross_domain", async () => {
        const capture = await takeCapture(
            deps(pool),
            makeJob(url("/redirect")),
        );
        expect(capture.invalid_reason).toBe("cross_domain");
        expect(capture.meta.final_url).toBe(
            `http://localhost:${server.port}/static`,
        );
    });

    it("challenge by title", async () => {
        const capture = await takeCapture(
            deps(pool),
            makeJob(url("/challenge-title")),
        );
        expect(capture.invalid_reason).toBe("challenge");
    });

    it("challenge by header, even on a 403", async () => {
        const capture = await takeCapture(
            deps(pool),
            makeJob(url("/challenge-header")),
        );
        expect(capture.invalid_reason).toBe("challenge");
        expect(capture.meta.http_status).toBe(403);
    });

    it("empty", async () => {
        const capture = await takeCapture(deps(pool), makeJob(url("/empty")));
        expect(capture.invalid_reason).toBe("empty");
        expect(capture.blocks).toEqual([]);
    });

    it("empty when the page has pictures and no words", async () => {
        const capture = await takeCapture(
            deps(pool),
            makeJob(url("/pictures-only")),
        );
        expect(capture.status).toBe("invalid");
        expect(capture.invalid_reason).toBe("empty");
        expect(capture.blocks.map(b => [b.tag, b.text])).toEqual([
            ["canvas", ""],
        ]);
        expect(capture.screenshot).toBeNull();
    });

    it("blank_screenshot", async () => {
        const capture = await takeCapture(deps(pool), makeJob(url("/blank")));
        expect(capture.invalid_reason).toBe("blank_screenshot");
        expect(capture.blocks.length).toBeGreaterThan(0);
    });

    it("does not save the storage state of an invalid Capture", async () => {
        const store = new MemoryStore();
        await takeCapture(
            deps(pool, store),
            makeJob(url("/missing"), {
                storage_state_key: storageStateKey(MONITOR_ID),
            }),
        );
        expect(store.objects.has(storageStateKey(MONITOR_ID))).toBe(false);
    });
});

describe("takeCapture: blocking", () => {
    it("applies the block lists", async () => {
        const blockers = createBlockerProvider({
            logger: silentLogger,
            load: async () => PlaywrightBlocker.parse("##.ad-banner"),
        });
        const capture = await takeCapture(
            deps(pool, new MemoryStore(), { blockers }),
            makeJob(url("/noise"), {
                capture: { block_ads: true },
            }),
        );

        expect(capture.status).toBe("ok");
        expect(capture.blocks.map(b => b.text)).toEqual([
            "Main content",
            "Limited offer",
        ]);
    });

    it("captures without blocking when the lists cannot be loaded", async () => {
        const blockers = createBlockerProvider({
            logger: silentLogger,
            load: async () => {
                throw new Error("offline");
            },
        });
        const capture = await takeCapture(
            deps(pool, new MemoryStore(), { blockers }),
            makeJob(url("/noise"), {
                capture: { block_ads: true, block_cookie_banners: true },
            }),
        );

        expect(capture.status).toBe("ok");
        expect(capture.blocks.map(b => b.text)).toContain(
            "Buy our sponsor's stuff",
        );
    });
});

describe("takeCapture: storage state", () => {
    it("restores the Monitor's state and saves it back after a valid Capture", async () => {
        const store = new MemoryStore();
        const key = storageStateKey(MONITOR_ID);
        const state = {
            cookies: [
                {
                    name: "variant",
                    value: "b",
                    domain: "127.0.0.1",
                    path: "/",
                    expires: -1,
                    httpOnly: false,
                    secure: false,
                    sameSite: "Lax",
                },
            ],
            origins: [],
        };
        await store.putObject(
            key,
            new TextEncoder().encode(JSON.stringify(state)),
        );

        const capture = await takeCapture(
            deps(pool, store),
            makeJob(url("/state"), { storage_state_key: key }),
        );

        expect(capture.blocks.map(b => b.text)).toEqual(["Cookie: variant=b"]);
        const saved = JSON.parse(
            new TextDecoder().decode(store.objects.get(key)!.body),
        ) as { cookies: { name: string }[] };
        expect(saved.cookies.map(c => c.name).sort()).toEqual([
            "variant",
            "visited",
        ]);
    });

    it("starts fresh when no state is stored yet", async () => {
        const store = new MemoryStore();
        const key = storageStateKey(MONITOR_ID);
        const capture = await takeCapture(
            deps(pool, store),
            makeJob(url("/state"), { storage_state_key: key }),
        );
        expect(capture.blocks.map(b => b.text)).toEqual(["Cookie: none"]);
        expect(store.objects.has(key)).toBe(true);
    });
});

describe("takeCapture: failures", () => {
    it("throws when the page cannot be loaded", async () => {
        await expect(
            takeCapture(deps(pool), makeJob("http://127.0.0.1:1/unreachable")),
        ).rejects.toThrow();
    });

    it("throws when screenshot storage is not configured", async () => {
        await expect(
            takeCapture(deps(pool, null), makeJob(url("/static"))),
        ).rejects.toThrow("Screenshot storage is not configured");
    });
});
