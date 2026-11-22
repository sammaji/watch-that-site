import type { LaunchOptions } from "playwright-core";
import { expect } from "vitest";

export type Deferred<T = void> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

export function createDeferred<T = void>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

export async function flushAsync(ticks = 25): Promise<void> {
    for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
}

export async function expectPending<T>(promise: Promise<T>): Promise<void> {
    promise.catch(() => undefined);
    await expect(
        Promise.race([
            promise.then(() => "settled"),
            flushAsync().then(() => "pending"),
        ]),
    ).resolves.toBe("pending");
}

let nextContextId = 1;
let launchCallCount = 0;
const launchFailures = new Map<number, Error>();
const deferredLaunches = new Map<number, Deferred<void>>();

export const launchCalls: LaunchOptions[] = [];
export const launchedBrowsers: FakeBrowser[] = [];

export class FakeBrowserContext {
    readonly id = nextContextId++;
    closed = false;
    closeCalls = 0;
    closeError: Error | null = null;
    closeGate: Deferred<void> | null = null;

    async close(): Promise<void> {
        this.closeCalls++;
        if (this.closeGate) {
            await this.closeGate.promise;
        }
        if (this.closeError) {
            throw this.closeError;
        }
        this.closed = true;
    }

    /** Scripts the pool installs in every context it opens. */
    readonly initScripts: unknown[] = [];

    async addInitScript(script: unknown): Promise<void> {
        this.initScripts.push(script);
    }

    async newPage(): Promise<{ close: () => Promise<void> }> {
        return {
            close: async () => undefined,
        };
    }
}

export class FakeBrowser {
    readonly contexts: FakeBrowserContext[] = [];
    connected = true;
    newContextCalls = 0;
    readonly newContextOptions: unknown[] = [];
    closeCalls = 0;
    newContextError: Error | null = null;
    failNewContextOnCalls = new Set<number>();
    closeError: Error | null = null;
    private readonly disconnectedListeners: Array<() => void> = [];
    private disconnectedEmitted = false;

    async newContext(options?: unknown): Promise<FakeBrowserContext> {
        this.newContextCalls++;
        this.newContextOptions.push(options);
        if (
            this.newContextError ||
            this.failNewContextOnCalls.has(this.newContextCalls)
        ) {
            throw this.newContextError ?? new Error("newContext failed");
        }

        const context = new FakeBrowserContext();
        this.contexts.push(context);
        return context;
    }

    on(event: "disconnected", cb: () => void): void {
        if (event === "disconnected") {
            this.disconnectedListeners.push(cb);
        }
    }

    emitDisconnected(): void {
        if (this.disconnectedEmitted) return;
        this.connected = false;
        this.disconnectedEmitted = true;
        for (const listener of this.disconnectedListeners) {
            listener();
        }
    }

    async close(): Promise<void> {
        this.closeCalls++;
        this.connected = false;
        this.emitDisconnected();
        if (this.closeError) {
            throw this.closeError;
        }
    }
}

export function resetFakePlaywright(): void {
    launchCalls.length = 0;
    launchedBrowsers.length = 0;
    launchFailures.clear();
    deferredLaunches.clear();
    launchCallCount = 0;
    nextContextId = 1;
}

export function failLaunchOnCall(
    n: number,
    err = new Error("launch failed"),
): void {
    launchFailures.set(n, err);
}

export function deferLaunchOnCall(n: number): Deferred<void> {
    const deferred = createDeferred<void>();
    deferredLaunches.set(n, deferred);
    return deferred;
}

async function launch(opts: LaunchOptions): Promise<FakeBrowser> {
    launchCallCount++;
    const call = launchCallCount;
    launchCalls.push(opts);

    await new Promise<void>(resolve => setImmediate(resolve));

    const deferred = deferredLaunches.get(call);
    if (deferred) {
        await deferred.promise;
    }

    const failure = launchFailures.get(call);
    if (failure) {
        throw failure;
    }

    const browser = new FakeBrowser();
    launchedBrowsers.push(browser);
    return browser;
}

export const fakeChromium = { launch };

export class LeaseInvariants {
    private readonly leased = new Set<unknown>();
    acquired = 0;
    released = 0;
    maxConcurrent = 0;

    onAcquire(ctx: unknown): void {
        if (this.leased.has(ctx)) {
            throw new Error("double-lease detected");
        }
        this.leased.add(ctx);
        this.acquired++;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.leased.size);
    }

    onRelease(ctx: unknown): void {
        if (!this.leased.delete(ctx)) {
            throw new Error("release without acquire detected");
        }
        this.released++;
    }

    assertQuiescent(capacity: number): void {
        expect(this.leased.size).toBe(0);
        expect(this.released).toBe(this.acquired);
        expect(this.maxConcurrent).toBeLessThanOrEqual(capacity);
    }
}
