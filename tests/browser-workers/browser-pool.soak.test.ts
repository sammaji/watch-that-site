import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { BrowserPool } from "../../services/browser-worker/src/lib/browser-pool.js";
import { LeaseInvariants } from "./lib/fake-playwright.js";

const enabled =
    process.env.LOAD_SOAK === "1" && !!process.env.PLAYWRIGHT_EXECUTABLE_PATH;

describe.runIf(enabled)("BrowserPool real Chromium soak", () => {
    it("runs 150 tasks on a 2x3 pool with isolation and memory checks", async () => {
        const pool = new BrowserPool({
            maxInstances: 2,
            maxContextsPerBrowser: 3,
        });
        const invariants = new LeaseInvariants();
        let nextTask = 0;
        let completed = 0;
        let heapAfterWarmup = 0;

        await pool.launch();
        try {
            const runWorker = async (): Promise<void> => {
                while (true) {
                    const taskIndex = nextTask++;
                    if (taskIndex >= 150) return;

                    const lease = await pool.acquire();
                    let page: Page | null = null;
                    invariants.onAcquire(lease.context);
                    try {
                        expect(await lease.context.cookies()).toEqual([]);
                        page = await lease.context.newPage();
                        await page.setContent("<h1>x</h1>");
                        await page.evaluate(() => document.title);
                        await lease.context.addCookies([
                            {
                                name: "soak",
                                value: "1",
                                domain: "example.com",
                                path: "/",
                            },
                        ]);
                    } finally {
                        await page?.close().catch(() => undefined);
                        invariants.onRelease(lease.context);
                        await lease.release();
                    }

                    completed++;
                    if (completed === 20) {
                        heapAfterWarmup = process.memoryUsage().heapUsed;
                    }
                }
            };

            await Promise.all(Array.from({ length: 6 }, () => runWorker()));

            expect(completed).toBe(150);
            invariants.assertQuiescent(6);

            const finalMemory = process.memoryUsage();
            const heapGrowth = finalMemory.heapUsed - heapAfterWarmup;
            console.log("BrowserPool soak memory", {
                rss: finalMemory.rss,
                heapUsed: finalMemory.heapUsed,
                heapGrowth,
            });
            expect(heapGrowth).toBeLessThan(150 * 1024 * 1024);
        } finally {
            await pool.close();
        }
    }, 120_000);
});
