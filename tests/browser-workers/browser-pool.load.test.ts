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
    flushAsync,
    launchedBrowsers,
    LeaseInvariants,
    resetFakePlaywright,
} from "./lib/fake-playwright.js";

const CAPACITY = 32;

function mulberry32(seed: number): () => number {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function nextInt(prng: () => number, max: number): number {
    return Math.floor(prng() * max);
}

async function launchLoadPool(): Promise<BrowserPool> {
    const pool = new BrowserPool({
        maxInstances: 4,
        maxContextsPerBrowser: 8,
    });
    await pool.launch();
    return pool;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetFakePlaywright();
    vi.unstubAllEnvs();
});

describe("BrowserPool mocked load", () => {
    it("handles 5,000 tasks in deterministic waves", async () => {
        const pool = await launchLoadPool();
        const invariants = new LeaseInvariants();
        const prng = mulberry32(0xdecafbad);
        let completed = 0;

        try {
            for (let wave = 0; wave < 20; wave++) {
                const tasks = Array.from({ length: 250 }, async () => {
                    const lease = await pool.acquire();
                    invariants.onAcquire(lease.context);
                    for (let i = 0; i < nextInt(prng, 4); i++) {
                        await Promise.resolve();
                    }
                    invariants.onRelease(lease.context);
                    await lease.release();
                    completed++;
                });
                await Promise.all(tasks);
            }

            expect(completed).toBe(5_000);
            invariants.assertQuiescent(CAPACITY);
        } finally {
            await pool.close();
        }
    });

    it("serves 200 queued waiters in exact FIFO order under saturation", async () => {
        const pool = await launchLoadPool();
        const resolvedOrder: number[] = [];
        const resolvedLeases: BrowserPoolContextLease[] = [];

        try {
            const held = await Promise.all(
                Array.from({ length: CAPACITY }, () => pool.acquire()),
            );

            const waiters = Array.from({ length: 200 }, (_, index) =>
                pool.acquire().then(lease => {
                    resolvedOrder.push(index);
                    resolvedLeases.push(lease);
                    return lease;
                }),
            );

            for (const lease of held) {
                await lease.release();
            }

            let releasedWaiters = 0;
            while (resolvedOrder.length < 200) {
                await vi.waitFor(() =>
                    expect(resolvedLeases.length).toBeGreaterThan(
                        releasedWaiters,
                    ),
                );
                const lease = resolvedLeases[releasedWaiters++]!;
                await lease.release();
            }

            await Promise.all(waiters);
            expect(resolvedOrder).toEqual(
                Array.from({ length: 200 }, (_, index) => index),
            );
        } finally {
            await pool.close();
        }
    });

    it("completes 2,000 tasks while periodically crashing browsers", async () => {
        const pool = await launchLoadPool();
        const invariants = new LeaseInvariants();
        const prng = mulberry32(0xdecafbad);
        let completed = 0;

        try {
            for (let wave = 0; wave < 10; wave++) {
                const tasks = Array.from({ length: 200 }, async () => {
                    const lease = await pool.acquire();
                    invariants.onAcquire(lease.context);
                    for (let i = 0; i < nextInt(prng, 4); i++) {
                        await Promise.resolve();
                    }
                    invariants.onRelease(lease.context);
                    await lease.release();
                    completed++;

                    if (completed % 200 === 0) {
                        const connected = launchedBrowsers.filter(
                            browser => browser.connected,
                        );
                        if (connected.length > 0) {
                            connected[
                                nextInt(prng, connected.length)
                            ]!.emitDisconnected();
                            await flushAsync();
                        }
                    }
                });
                await Promise.all(tasks);
            }

            expect(completed).toBe(2_000);
            invariants.assertQuiescent(CAPACITY);
            await flushAsync();

            const fullCapacity = await Promise.all(
                Array.from({ length: CAPACITY }, () => pool.acquire()),
            );
            expect(fullCapacity.length).toBe(CAPACITY);
            await Promise.all(fullCapacity.map(lease => lease.release()));
        } finally {
            await pool.close();
        }
    });

    it("settles every task when closed under load", async () => {
        const pool = await launchLoadPool();
        const prng = mulberry32(0xdecafbad);
        const failures: string[] = [];
        let successes = 0;
        let closePromise: Promise<void> | null = null;

        const runTask = async (): Promise<void> => {
            const lease = await pool.acquire();
            try {
                for (let i = 0; i < nextInt(prng, 4); i++) {
                    await Promise.resolve();
                }
            } finally {
                await lease.release();
            }
        };

        const tasks: Array<Promise<void>> = [];
        for (let i = 0; i < 500; i++) {
            tasks.push(
                runTask()
                    .then(() => {
                        successes++;
                    })
                    .catch((err: Error) => {
                        failures.push(err.message);
                    }),
            );
            if (i === 249) {
                closePromise = pool.close();
            }
        }

        await Promise.allSettled(tasks);
        await closePromise;

        expect(successes + failures.length).toBe(500);
        expect(
            failures.every(message =>
                [
                    "BrowserPool is closed",
                    "BrowserPool closed while waiting for a slot",
                ].includes(message),
            ),
        ).toBe(true);
    });
});
