import {
    chromium,
    type Browser,
    type BrowserContext,
    type BrowserContextOptions,
    type LaunchOptions,
} from "playwright-core";

/**
 * Settings pinned on every context so Captures are reproducible between Runs
 * and between workers: the same locale and timezone render the same
 * dates and number formats, and a scale factor of 1 keeps screenshot pixels
 * equal to CSS pixels.
 */
export const pinnedContextOptions = {
    locale: "en-US",
    timezoneId: "UTC",
    deviceScaleFactor: 1,
} as const satisfies BrowserContextOptions;

/**
 * Functions passed to `page.evaluate` are serialized and run inside the page.
 * The worker runs under tsx, whose transpiler (esbuild with keepNames) wraps
 * nested functions in a `__name(...)` helper that exists in Node but not in
 * the page, so every such function would throw "__name is not defined". This
 * defines the helper in every document before any of our code runs there.
 */
const NAME_HELPER = "globalThis.__name ??= (target => target);";

/** Opens a context that page-side code can run in. */
async function openContext(
    browser: Browser,
    options: BrowserContextOptions,
): Promise<BrowserContext> {
    const context = await browser.newContext(options);
    await context.addInitScript(NAME_HELPER);
    return context;
}

/** Per-lease context settings on top of the pinned ones. */
export type ContextOptions = Pick<
    BrowserContextOptions,
    "storageState" | "viewport"
>;

export type BrowserPoolConfig = {
    maxInstances: number;
    maxContextsPerBrowser: number;
    maxJsHeapSizeMb?: number;
};

export type BrowserPoolContextLease = {
    context: BrowserContext;
    release: () => Promise<void>;
};

type BrowserPoolWaiter = {
    resolve: (lease: BrowserPoolContextLease) => void;
    reject: (err: Error) => void;
};

type BrowserPoolManagedContext = {
    browser: Browser;
    context: BrowserContext;
    browserIndex: number;
};

/**
 * A strict object pool for Playwright BrowserContexts.
 *
 * It pre-allocates a fixed number of BrowserContexts and recycles them. This enforces
 * strict capacity limits and guarantees a completely flat memory profile over time,
 * acting exactly like a connection pool in Go or database connections.
 *
 * When a context is released, all of its open pages (tabs) are forcefully
 * closed, and cookies are cleared to reset it for the next caller.
 */
export class BrowserPool {
    private readonly config: BrowserPoolConfig;
    private browsers: (Browser | null)[] = [];
    private freeContexts: BrowserPoolManagedContext[] = [];
    private waiters: BrowserPoolWaiter[] = [];
    private closed = false;
    // Leased context → its slot, so acquireWith() can swap the context.
    private readonly leased = new WeakMap<
        BrowserContext,
        BrowserPoolManagedContext
    >();

    constructor(config: BrowserPoolConfig) {
        this.config = config;
    }

    async launch(): Promise<void> {
        const launched: Browser[] = [];

        try {
            for (let i = 0; i < this.config.maxInstances; i++) {
                const browser = await this.launchBrowser();
                launched.push(browser);
                this.browsers[i] = browser;
                await this.populateContexts(browser, i);
                this.registerCrashHandler(browser, i);
            }
        } catch (err) {
            // Mark the pool dead *before* closing: closing fires each browser's
            // `disconnected` event, and the crash handler would otherwise treat
            // a deliberate rollback as a crash and launch replacements that
            // nothing tracks or ever closes.
            this.closed = true;
            await Promise.allSettled(launched.map(b => b.close()));
            throw err;
        }
    }

    private async launchBrowser(): Promise<Browser> {
        const args = [
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ];

        if (this.config.maxJsHeapSizeMb) {
            args.push(
                `--js-flags=--max-old-space-size=${this.config.maxJsHeapSizeMb}`,
            );
        }

        const opts: LaunchOptions = {
            headless: true,
            args,
        };
        if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
            opts.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
        }
        return await chromium.launch(opts);
    }

    private async populateContexts(browser: Browser, index: number) {
        for (let j = 0; j < this.config.maxContextsPerBrowser; j++) {
            const context = await openContext(browser, pinnedContextOptions);
            this.freeContexts.push({ browser, context, browserIndex: index });
        }
    }

    acquire(): Promise<BrowserPoolContextLease> {
        if (this.closed) {
            return Promise.reject(new Error("BrowserPool is closed"));
        }

        // If we have a free context, pull it directly from the pool
        if (this.freeContexts.length > 0) {
            const mc = this.freeContexts.shift()!;
            return Promise.resolve(this.buildLease(mc));
        }

        // No slot available - enqueue caller and block until release() wakes us.
        return new Promise<BrowserPoolContextLease>((resolve, reject) => {
            this.waiters.push({ resolve, reject });
        });
    }

    /**
     * Leases a slot whose context is created with custom options, for a Run
     * that restores a persisted storage state. The slot's pre-created context
     * is swapped for a fresh one built from `options` plus the pinned
     * settings; release recycles it exactly like any other lease.
     */
    async acquireWith(
        options: ContextOptions,
    ): Promise<BrowserPoolContextLease> {
        const lease = await this.acquire();
        const mc = this.leased.get(lease.context);
        if (!mc) {
            await lease.release();
            throw new Error("BrowserPool lease has no managed context");
        }
        this.leased.delete(lease.context);

        try {
            await mc.context.close().catch(() => undefined);
            mc.context = await openContext(mc.browser, {
                ...options,
                ...pinnedContextOptions,
            });
        } catch (err) {
            await lease.release();
            throw err;
        }

        return { context: mc.context, release: lease.release };
    }

    async close(): Promise<void> {
        this.closed = true;

        const pendingError = new Error(
            "BrowserPool closed while waiting for a slot",
        );
        for (const waiter of this.waiters) {
            waiter.reject(pendingError);
        }
        this.waiters = [];

        const toClose = this.browsers.filter((b): b is Browser => b !== null);
        await Promise.allSettled(toClose.map(b => b.close()));
    }

    private registerCrashHandler(browser: Browser, index: number): void {
        browser.on("disconnected", () => {
            if (this.closed) return;
            // Only the browser currently occupying this slot may retire it.
            // A browser we already retired deliberately fires this event too,
            // and acting on it a second time would launch a duplicate.
            if (this.browsers[index] !== browser) return;

            this.retireBrowser(index);
            void this.replaceBrowser(index);
        });
    }

    /** Drops a browser from the pool along with any free contexts it owns. */
    private retireBrowser(index: number): void {
        this.browsers[index] = null;
        this.freeContexts = this.freeContexts.filter(
            c => c.browserIndex !== index,
        );
    }

    private async replaceBrowser(index: number): Promise<void> {
        try {
            const replacement = await this.launchBrowser();
            if (this.closed) {
                await replacement.close().catch(() => undefined);
                return;
            }

            this.browsers[index] = replacement;
            await this.populateContexts(replacement, index);
            this.registerCrashHandler(replacement, index);

            // Wake up waiters now that we have fresh contexts
            this.drainWaiters();
        } catch {
            // Relaunch failed - capacity stays reduced. The pool will continue
            // operating with the remaining healthy browser instances.
        }
    }

    private drainWaiters(): void {
        while (this.waiters.length > 0 && this.freeContexts.length > 0) {
            const next = this.waiters.shift()!;
            const mc = this.freeContexts.shift()!;
            next.resolve(this.buildLease(mc));
        }
    }

    private buildLease(mc: BrowserPoolManagedContext): BrowserPoolContextLease {
        // One lease may only be returned once. Without this a double release
        // puts the same context back twice, and the pool then hands one
        // context to two callers at the same time.
        let released = false;
        this.leased.set(mc.context, mc);

        const release = async () => {
            if (released) return;
            released = true;
            this.leased.delete(mc.context);

            if (this.closed) return;

            // If browser crashed while the lease was out, this context is dead. Discard it.
            if (this.browsers[mc.browserIndex] !== mc.browser) return;

            // Destroy the dirty context and create a completely fresh one for perfect isolation.
            try {
                await mc.context.close().catch(() => undefined);
                mc.context = await openContext(
                    mc.browser,
                    pinnedContextOptions,
                );
            } catch {
                // The browser can no longer produce contexts, so this slot is
                // gone for good. Retire the browser and relaunch it rather than
                // dropping the slot silently, which would leave anyone queued
                // on acquire() waiting forever.
                this.recycleBrokenBrowser(mc.browserIndex, mc.browser);
                return;
            }

            // Re-verify browser didn't crash during the async cleanup
            if (this.browsers[mc.browserIndex] !== mc.browser) return;

            // Return to pool or hand to the next waiter
            if (this.waiters.length > 0) {
                const next = this.waiters.shift()!;
                next.resolve(this.buildLease(mc));
            } else {
                this.freeContexts.push(mc);
            }
        };

        return { context: mc.context, release };
    }

    /**
     * Replaces a browser that is still connected but can no longer produce
     * contexts. Retiring the slot first means the browser's own `disconnected`
     * event is ignored, so exactly one replacement is launched.
     */
    private recycleBrokenBrowser(index: number, browser: Browser): void {
        if (this.closed || this.browsers[index] !== browser) return;

        this.retireBrowser(index);
        void browser.close().catch(() => undefined);
        void this.replaceBrowser(index);
    }
}
