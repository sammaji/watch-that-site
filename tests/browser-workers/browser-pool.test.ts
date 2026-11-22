import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("playwright-core", async () => {
    const { fakeChromium } = await import("./lib/fake-playwright.js");
    return { chromium: fakeChromium };
});

import {
    BrowserPool,
    type BrowserPoolContextLease,
} from "../../services/browser-worker/src/lib/browser-pool.js";
import {
    createDeferred,
    deferLaunchOnCall,
    expectPending,
    failLaunchOnCall,
    FakeBrowserContext,
    flushAsync,
    launchCalls,
    launchedBrowsers,
    resetFakePlaywright,
} from "./lib/fake-playwright.js";

async function launchPool(
    maxInstances: number,
    maxContextsPerBrowser: number,
    maxJsHeapSizeMb?: number,
): Promise<BrowserPool> {
    const pool = new BrowserPool({
        maxInstances,
        maxContextsPerBrowser,
        ...(maxJsHeapSizeMb ? { maxJsHeapSizeMb } : {}),
    });
    await pool.launch();
    return pool;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetFakePlaywright();
    vi.unstubAllEnvs();
});

describe("BrowserPool launch", () => {
    it("pre-allocates full capacity and serves it all concurrently", async () => {
        const pool = await launchPool(2, 3);

        try {
            expect(launchCalls.length).toBe(2);
            expect(launchedBrowsers.length).toBe(2);
            expect(
                launchedBrowsers.map(browser => browser.newContextCalls),
            ).toEqual([3, 3]);

            const leases = await Promise.all(
                Array.from({ length: 6 }, () => pool.acquire()),
            );
            expect(new Set(leases.map(lease => lease.context)).size).toBe(6);

            const seventh = pool.acquire();
            seventh.catch(() => undefined);
            await expectPending(seventh);
            await pool.close();
            await expect(seventh).rejects.toThrow(
                "BrowserPool closed while waiting for a slot",
            );
        } finally {
            await pool.close();
        }
    });

    it("launches headless with hardening flags and no js-flags by default", async () => {
        const pool = await launchPool(1, 1);
        try {
            expect(launchCalls[0]?.headless).toBe(true);
            // The Chromium sandbox is deliberately left enabled: this worker
            // loads arbitrary third-party pages, and --no-sandbox would remove
            // the boundary that contains a compromised renderer. If a
            // deployment cannot start Chromium sandboxed, run it as a non-root
            // user with the right seccomp profile rather than adding the flag.
            expect(launchCalls[0]?.args).not.toContain("--no-sandbox");
            expect(launchCalls[0]?.args).not.toContain(
                "--disable-setuid-sandbox",
            );
            expect(launchCalls[0]?.args).toEqual(
                expect.arrayContaining([
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                ]),
            );
            expect(
                launchCalls[0]?.args?.some(arg =>
                    arg.startsWith("--js-flags="),
                ),
            ).toBe(false);
        } finally {
            await pool.close();
        }
    });

    it("adds the V8 heap flag when maxJsHeapSizeMb is configured", async () => {
        const pool = await launchPool(1, 1, 512);
        try {
            expect(launchCalls[0]?.args).toContain(
                "--js-flags=--max-old-space-size=512",
            );
        } finally {
            await pool.close();
        }
    });

    it("honors PLAYWRIGHT_EXECUTABLE_PATH when set", async () => {
        vi.stubEnv("PLAYWRIGHT_EXECUTABLE_PATH", "/fake/chromium");
        const pool = await launchPool(1, 1);
        try {
            expect(launchCalls[0]?.executablePath).toBe("/fake/chromium");
        } finally {
            await pool.close();
        }
    });

    it("omits executablePath when PLAYWRIGHT_EXECUTABLE_PATH is unset", async () => {
        vi.stubEnv("PLAYWRIGHT_EXECUTABLE_PATH", "");
        const pool = await launchPool(1, 1);
        try {
            expect("executablePath" in launchCalls[0]!).toBe(false);
        } finally {
            await pool.close();
        }
    });

    it("rolls back and rethrows partial launch failure", async () => {
        failLaunchOnCall(2, new Error("launch-2 failed"));
        const pool = new BrowserPool({
            maxInstances: 2,
            maxContextsPerBrowser: 2,
        });

        await expect(pool.launch()).rejects.toThrow("launch-2 failed");
        expect(launchedBrowsers.length).toBe(1);
        expect(launchedBrowsers[0]?.connected).toBe(false);
    });

    it("does not spawn a zombie replacement during launch rollback", async () => {
        failLaunchOnCall(2, new Error("launch-2 failed"));
        const pool = new BrowserPool({
            maxInstances: 2,
            maxContextsPerBrowser: 2,
        });

        try {
            await expect(pool.launch()).rejects.toThrow("launch-2 failed");
            await flushAsync();
            expect(launchCalls.length).toBe(2);
        } finally {
            await pool.close();
        }
    });

    it("allows maxInstances: 0 and leaves acquire pending until close", async () => {
        const pool = await launchPool(0, 5);
        const pending = pool.acquire();
        pending.catch(() => undefined);

        await expectPending(pending);
        expect(launchCalls.length).toBe(0);
        await pool.close();
        await expect(pending).rejects.toThrow(
            "BrowserPool closed while waiting for a slot",
        );
    });

    it("allows maxContextsPerBrowser: 0 and leaves acquire pending until close", async () => {
        const pool = await launchPool(2, 0);
        const pending = pool.acquire();
        pending.catch(() => undefined);

        expect(launchCalls.length).toBe(2);
        expect(
            launchedBrowsers.map(browser => browser.newContextCalls),
        ).toEqual([0, 0]);
        await expectPending(pending);
        await pool.close();
    });
});

describe("BrowserPool acquire", () => {
    it("never double-leases at capacity", async () => {
        const pool = await launchPool(2, 2);

        try {
            const leases = await Promise.all(
                Array.from({ length: 4 }, () => pool.acquire()),
            );
            expect(new Set(leases.map(lease => lease.context)).size).toBe(4);
            const pending1 = pool.acquire();
            const pending2 = pool.acquire();
            pending1.catch(() => undefined);
            pending2.catch(() => undefined);
            await expectPending(Promise.race([pending1, pending2]));
        } finally {
            await pool.close();
        }
    });

    it("serves waiters in strict FIFO order", async () => {
        const pool = await launchPool(1, 1);
        const order: string[] = [];
        let leaseA: BrowserPoolContextLease | null = null;
        let leaseB: BrowserPoolContextLease | null = null;
        let leaseC: BrowserPoolContextLease | null = null;

        try {
            const lease = await pool.acquire();
            const waiterA = pool.acquire().then(next => {
                leaseA = next;
                order.push("A");
            });
            const waiterB = pool.acquire().then(next => {
                leaseB = next;
                order.push("B");
            });
            const waiterC = pool.acquire().then(next => {
                leaseC = next;
                order.push("C");
            });

            await lease.release();
            await vi.waitFor(() => expect(order.length).toBe(1));
            await waiterA;
            await leaseA!.release();
            await vi.waitFor(() => expect(order.length).toBe(2));
            await waiterB;
            await leaseB!.release();
            await vi.waitFor(() => expect(order.length).toBe(3));
            await waiterC;

            expect(order).toEqual(["A", "B", "C"]);
            await leaseC!.release();
        } finally {
            await pool.close();
        }
    });

    it("rejects acquire immediately after close", async () => {
        const pool = await launchPool(1, 1);
        await pool.close();
        await expect(pool.acquire()).rejects.toThrow("BrowserPool is closed");
    });
});

describe("BrowserPool release", () => {
    it("recycles the context for isolation by destroying it and creating a fresh one", async () => {
        const pool = await launchPool(1, 1);
        try {
            const lease = await pool.acquire();
            const oldCtx = lease.context as unknown as FakeBrowserContext;
            const browser = launchedBrowsers[0]!;
            const callsBefore = browser.newContextCalls;

            await lease.release();

            expect(oldCtx.closed).toBe(true);
            expect(browser.newContextCalls).toBe(callsBefore + 1);
            const lease2 = await pool.acquire();
            expect(
                (lease2.context as unknown as FakeBrowserContext).id,
            ).not.toBe(oldCtx.id);
            await lease2.release();
        } finally {
            await pool.close();
        }
    });

    it("hands a fresh context directly to the next waiter", async () => {
        const pool = await launchPool(1, 1);

        try {
            const lease = await pool.acquire();
            const oldCtx = lease.context as unknown as FakeBrowserContext;
            const waiter = pool.acquire();
            waiter.catch(() => undefined);

            await lease.release();
            const waiterLease = await waiter;
            expect(
                (waiterLease.context as unknown as FakeBrowserContext).id,
            ).not.toBe(oldCtx.id);

            const extra = pool.acquire();
            extra.catch(() => undefined);
            await expectPending(extra);
            await waiterLease.release();
        } finally {
            await pool.close();
        }
    });

    it("returns to the free list when there are no waiters", async () => {
        const pool = await launchPool(1, 1);
        try {
            const lease = await pool.acquire();
            await lease.release();

            const reacquire = pool.acquire();
            await expect(
                Promise.race([
                    reacquire.then(() => "settled"),
                    flushAsync(1).then(() => "pending"),
                ]),
            ).resolves.toBe("settled");
            const lease2 = await reacquire;
            await lease2.release();
        } finally {
            await pool.close();
        }
    });

    it("makes release after close a no-op", async () => {
        const pool = await launchPool(1, 1);
        const lease = await pool.acquire();
        const ctx = lease.context as unknown as FakeBrowserContext;
        const browser = launchedBrowsers[0]!;
        const callsBefore = browser.newContextCalls;

        await pool.close();
        await lease.release();

        expect(browser.newContextCalls).toBe(callsBefore);
        expect(ctx.closeCalls).toBe(0);
    });

    it("discards a lease when its browser crashed before cleanup", async () => {
        const deferred = deferLaunchOnCall(2);
        const pool = await launchPool(1, 1);

        try {
            const lease = await pool.acquire();
            const ctx = lease.context as unknown as FakeBrowserContext;
            const browser0 = launchedBrowsers[0]!;

            browser0.emitDisconnected();
            await flushAsync();
            const callsBefore = browser0.newContextCalls;
            const closeCallsBefore = ctx.closeCalls;

            await lease.release();

            expect(browser0.newContextCalls).toBe(callsBefore);
            expect(ctx.closeCalls).toBe(closeCallsBefore);
        } finally {
            deferred.resolve();
            await flushAsync();
            await pool.close();
        }
    });

    it("discards a lease when its browser crashes during async cleanup", async () => {
        const pool = await launchPool(1, 1);

        try {
            const lease = await pool.acquire();
            const ctx = lease.context as unknown as FakeBrowserContext;
            const browser0 = launchedBrowsers[0]!;
            ctx.closeGate = createDeferred<void>();

            const releasePromise = lease.release();
            browser0.emitDisconnected();
            await flushAsync();

            ctx.closeGate.resolve();
            await releasePromise;

            const replacementLease = await pool.acquire();
            expect(launchedBrowsers[1]?.contexts).toContain(
                replacementLease.context,
            );
            const extra = pool.acquire();
            extra.catch(() => undefined);
            await expectPending(extra);
            await replacementLease.release();
        } finally {
            await pool.close();
        }
    });

    it("swallows context.close errors during recycle and proceeds", async () => {
        const pool = await launchPool(1, 1);
        try {
            const lease = await pool.acquire();
            const ctx = lease.context as unknown as FakeBrowserContext;
            const browser = launchedBrowsers[0]!;
            const callsBefore = browser.newContextCalls;
            ctx.closeError = new Error("close boom");

            await lease.release();

            expect(browser.newContextCalls).toBe(callsBefore + 1);
            const lease2 = await pool.acquire();
            expect(
                (lease2.context as unknown as FakeBrowserContext).id,
            ).not.toBe(ctx.id);
            await lease2.release();
        } finally {
            await pool.close();
        }
    });

    it("does not starve waiters when recycle fails", async () => {
        const pool = await launchPool(1, 1);
        try {
            const lease = await pool.acquire();
            let waiterResolved = false;
            const waiter = pool.acquire().then(next => {
                waiterResolved = true;
                return next;
            });
            waiter.catch(() => undefined);

            launchedBrowsers[0]!.newContextError = new Error("boom");
            await lease.release();

            await vi.waitFor(() => expect(waiterResolved).toBe(true), {
                timeout: 500,
            });
        } finally {
            await pool.close();
        }
    });

    it("makes double release idempotent", async () => {
        const pool = await launchPool(1, 1);
        try {
            const lease = await pool.acquire();
            const browser = launchedBrowsers[0]!;
            const callsBefore = browser.newContextCalls;

            await lease.release();
            await lease.release();

            expect(browser.newContextCalls).toBe(callsBefore + 1);
            const lease1 = await pool.acquire();
            const lease2 = pool.acquire();
            lease2.catch(() => undefined);
            await expectPending(lease2);
            await lease1.release();
        } finally {
            await pool.close();
        }
    });
});

describe("BrowserPool crash handling", () => {
    it("purges crashed free contexts, replaces the browser, and drains waiters", async () => {
        const deferred = deferLaunchOnCall(3);
        const pool = await launchPool(2, 1);

        try {
            const lease0 = await pool.acquire();
            const lease1 = await pool.acquire();
            const waiter = pool.acquire();
            waiter.catch(() => undefined);

            launchedBrowsers[0]!.emitDisconnected();
            await flushAsync();
            await lease0.release();
            await expectPending(waiter);

            deferred.resolve();
            await vi.waitFor(() => expect(launchedBrowsers.length).toBe(3));
            const waiterLease = await waiter;
            expect(launchedBrowsers[2]?.contexts).toContain(
                waiterLease.context,
            );
            expect(waiterLease.context).not.toBe(lease0.context);

            await waiterLease.release();
            await lease1.release();
        } finally {
            await pool.close();
        }
    });

    it("keeps working with reduced capacity when relaunch fails", async () => {
        failLaunchOnCall(3, new Error("replacement failed"));
        const pool = await launchPool(2, 1);

        try {
            launchedBrowsers[0]!.emitDisconnected();
            await flushAsync();

            const lease1 = await pool.acquire();
            const lease2 = pool.acquire();
            lease2.catch(() => undefined);
            await expectPending(lease2);

            await lease1.release();
            const cycledLease = await lease2;
            await cycledLease.release();
            const lease3 = await pool.acquire();
            const pendingAfterCycle = pool.acquire();
            pendingAfterCycle.catch(() => undefined);
            await expectPending(pendingAfterCycle);
            void lease3;
        } finally {
            await pool.close();
        }
    });

    it("ignores crashes after close", async () => {
        const pool = await launchPool(1, 1);
        await pool.close();
        const calls = launchCalls.length;

        launchedBrowsers[0]!.emitDisconnected();
        await flushAsync();

        expect(launchCalls.length).toBe(calls);
    });

    it("closes a replacement that finishes after pool close", async () => {
        const deferred = deferLaunchOnCall(2);
        const pool = await launchPool(1, 1);

        launchedBrowsers[0]!.emitDisconnected();
        await pool.close();
        deferred.resolve();

        await vi.waitFor(() =>
            expect(launchedBrowsers[1]?.connected).toBe(false),
        );
    });
});

describe("BrowserPool close", () => {
    it("rejects all pending waiters and closes browsers", async () => {
        const pool = await launchPool(1, 1);
        const errors: string[] = [];

        await pool.acquire();
        for (let i = 0; i < 3; i++) {
            pool.acquire().catch((err: Error) => errors.push(err.message));
        }

        await pool.close();
        await flushAsync();

        expect(errors).toEqual([
            "BrowserPool closed while waiting for a slot",
            "BrowserPool closed while waiting for a slot",
            "BrowserPool closed while waiting for a slot",
        ]);
        expect(launchedBrowsers.every(browser => !browser.connected)).toBe(
            true,
        );
    });

    it("uses Promise.allSettled semantics when browser close throws", async () => {
        const pool = await launchPool(2, 1);
        launchedBrowsers[0]!.closeError = new Error("close failed");

        await expect(pool.close()).resolves.toBeUndefined();
        expect(launchedBrowsers[0]?.closeCalls).toBeGreaterThanOrEqual(1);
        expect(launchedBrowsers[1]?.closeCalls).toBeGreaterThanOrEqual(1);
    });

    it("is safe to close twice", async () => {
        const pool = await launchPool(1, 1);

        await pool.close();
        await expect(pool.close()).resolves.toBeUndefined();
    });

    it("resolves with leases outstanding and makes late releases no-ops", async () => {
        const pool = await launchPool(2, 2);
        const lease1 = await pool.acquire();
        const lease2 = await pool.acquire();
        const callsBefore = launchedBrowsers.map(
            browser => browser.newContextCalls,
        );

        await pool.close();
        await lease1.release();
        await lease2.release();

        expect(
            launchedBrowsers.map(browser => browser.newContextCalls),
        ).toEqual(callsBefore);
    });
});

describe("BrowserPool context options", () => {
    const pinned = { locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1 };

    it("pins locale, timezone and scale factor on every context", async () => {
        const pool = await launchPool(1, 2);
        try {
            const browser = launchedBrowsers[0]!;
            const lease = await pool.acquire();
            await lease.release();

            expect(browser.newContextOptions).toHaveLength(3);
            for (const options of browser.newContextOptions) {
                expect(options).toEqual(pinned);
            }
        } finally {
            await pool.close();
        }
    });

    it("acquireWith swaps the slot's context for one with custom options", async () => {
        const pool = await launchPool(1, 1);
        try {
            const browser = launchedBrowsers[0]!;
            const original = browser.contexts[0]!;
            const storageState = { cookies: [], origins: [] };

            const lease = await pool.acquireWith({
                storageState,
                viewport: { width: 1366, height: 768 },
            });

            expect(original.closed).toBe(true);
            expect(lease.context).toBe(browser.contexts[1]);
            expect(browser.newContextOptions[1]).toEqual({
                storageState,
                viewport: { width: 1366, height: 768 },
                ...pinned,
            });

            // The slot is still capacity-limited and recycles on release.
            const waiter = pool.acquire();
            await expectPending(waiter);
            await lease.release();
            const next = await waiter;
            expect(
                (lease.context as unknown as FakeBrowserContext).closed,
            ).toBe(true);
            expect(browser.newContextOptions[2]).toEqual(pinned);
            await next.release();
        } finally {
            await pool.close();
        }
    });

    it("acquireWith returns the slot when the custom context cannot be created", async () => {
        const pool = await launchPool(1, 1);
        try {
            const browser = launchedBrowsers[0]!;
            browser.failNewContextOnCalls.add(2);

            await expect(
                pool.acquireWith({
                    storageState: { cookies: [], origins: [] },
                }),
            ).rejects.toThrow("newContext failed");

            const lease = await pool.acquire();
            expect(lease.context).toBe(browser.contexts.at(-1));
            await lease.release();
        } finally {
            await pool.close();
        }
    });
});
