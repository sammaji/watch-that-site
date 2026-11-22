# Unit + Load Tests for BrowserPool

## Context

`services/browser-worker/src/lib/browser-pool.ts` is a strict object pool for Playwright BrowserContexts (pre-allocated `maxInstances × maxContextsPerBrowser` contexts, FIFO waiter queue, context recycling on release, crash-replacement of browsers). It currently has **zero test coverage**. Goal: comprehensive unit tests covering every edge case, plus load/stress tests.

**Decisions:**
- ALL test code lives in the existing `@watchthatsite/tests` package under **`tests/browser-workers/`** (NOT co-located in the service). No test files under `services/`.
- **No production code changes.** There will be bugs so tests will fail. Please do not change test behaviour to make them pass. You can mark failing tests with `it.fail()`.

### Confirmed bugs (test-pinned, not fixed)
- **Bug A — double-release** (`buildLease`, browser-pool.ts:179-209): no idempotency guard. A second `release()` re-recycles and double-pushes the shared managed-context object → two later `acquire()`s can receive the same context.
- **Bug B — waiter starvation on failed recycle** (browser-pool.ts:187-194): if `browser.newContext()` throws during release, the slot is silently discarded; queued waiters are never drained → can hang forever; capacity shrinks permanently.
- **Bug C — zombie browser on partial-launch rollback** (browser-pool.ts:51-66): crash handlers are registered per-iteration inside the launch loop; if browser N+1's launch fails, the rollback `close()` of browser N fires `disconnected` while `closed === false` → background `replaceBrowser()` launches a replacement Chromium even though `launch()` rethrew → leaked browser process.

## Repo facts (verified)
- `tests/package.json` (`@watchthatsite/tests`): ESM, vitest ^3.2.1, scripts follow `"test:<area>": "vitest run --dir <area>"`. `tests/vitest.config.ts`: `testTimeout: 30_000`, `hookTimeout: 15_000`.
- Existing cross-package import precedent: `tests/unit/proxy-runtime.test.ts` reaches into `../../services/proxy/runtime.js` by relative path. For TS source, import directly: `import { BrowserPool } from "../../services/browser-worker/src/lib/browser-pool.js"` (NodeNext `.js`→`.ts` mapping; vitest already handles this pattern in `services/browser-worker/src/handler/scrape-job.test.ts`).
- `playwright-core` is a dependency of browser-worker only. The tests package must add `"playwright-core": "^1.60.0"` to its devDependencies so `vi.mock("playwright-core")` resolves from the test files and pnpm dedupes both to the same module instance. Verify after install that the mock intercepts the copy browser-pool.ts imports (single version → single resolved ID).
- `playwright-core` bundles no browsers. Real Chromium only via `PLAYWRIGHT_EXECUTABLE_PATH` (read at browser-pool.ts:91-92).
- No load-test tooling in repo; load tests are Vitest-driven. No new heavyweight dependencies.
- Production consumer: `services/browser-worker/src/lib/scraper.ts` (acquire → newPage → work → page.close → release in try/finally). Prod config: 2 browsers × 10 contexts.

## Design decisions
1. Mock via `vi.mock("playwright-core", async () => ({ chromium: fakeChromium }))` with a shared fake module. No `importOriginal` needed — browser-pool.ts value-imports only `chromium`; `Browser`/`BrowserContext`/`LaunchOptions` are type-only (erased).
2. Black-box testing through the public API (`launch/acquire/release/close`) + observability via the fakes' recorded state. No test-only accessors added to `BrowserPool`.
3. No fake timers (pool has zero timers); determinism via microtask/`setImmediate` flushing (`flushAsync`) + `vi.waitFor`.
4. Mocked load test is ungated (fast, deterministic). Real-Chromium soak is a separate file (vi.mock is file-scoped, can't share) gated via `describe.runIf(process.env.LOAD_TEST === "1" && !!process.env.PLAYWRIGHT_EXECUTABLE_PATH)`.

## Files to create/modify

| File | Change |
|---|---|
| `tests/browser-workers/testing-browser-worker-plan.md` | This plan (already in place). |
| `tests/browser-workers/lib/fake-playwright.ts` | NEW — fake `chromium`, `FakeBrowser`, `FakeBrowserContext`, knobs, `createDeferred`, `flushAsync`, `expectPending`, `LeaseInvariants`, `resetFakePlaywright`. Not `*.test.ts`, so vitest won't collect it. |
| `tests/browser-workers/browser-pool.test.ts` | NEW — 26 unit cases (fully specified below). |
| `tests/browser-workers/browser-pool.load.test.ts` | NEW — 4 mocked load/stress cases (fully specified below). |
| `tests/browser-workers/browser-pool.soak.test.ts` | NEW — 1 gated real-Chromium soak case (fully specified below). |
| `tests/package.json` | Add devDep `"playwright-core": "^1.60.0"`; add scripts `"test:browser-worker": "vitest run --dir browser-workers"` and `"test:browser-worker:load": "LOAD_TEST=1 vitest run --dir browser-workers"` (POSIX env prefix, no cross-env). |

### `lib/fake-playwright.ts` contents
Fake only the surface BrowserPool touches:
- `FakeBrowserContext`: monotonic global `id` (identity assertions), `closed` flag, knobs `closeError` (make `close()` throw) and `closeGate: Deferred | null` (make `close()` hang until the test resolves it), stub `newPage()` returning `{ close: async () => {} }`.
- `FakeBrowser`: `contexts: FakeBrowserContext[]`, `connected = true`, `newContextCalls = 0`, knobs `newContextError: Error | null` (fail ALL newContext calls) / `failNewContextOnCalls: Set<number>` (fail Nth call, 1-based), `closeError`; `on("disconnected", cb)` registers listeners, `emitDisconnected()` fires them (test-triggered crash), `close()` sets `connected = false` then calls `emitDisconnected()` (mirrors real Playwright: close fires disconnected).
- Module-level singleton controller (reset per test): `launchCalls: LaunchOptions[]` (records every `chromium.launch(opts)` arg), `launchedBrowsers: FakeBrowser[]` (every browser successfully created, in creation order), `resetFakePlaywright()`, `failLaunchOnCall(n, err?)` (1-based launch index rejects), `deferLaunchOnCall(n)` → returns a Deferred; the Nth launch call only resolves (creating the browser) after the test resolves it, `fakeChromium = { launch }`.
- Determinism helpers: `createDeferred<T>()` → `{ promise, resolve, reject }`; `flushAsync(ticks = 25)` → loop `await Promise.resolve()` `ticks` times then `await new Promise(r => setImmediate(r))`; `expectPending(p)` → attach `p.catch(() => {})` FIRST (avoid unhandled rejection), then `await expect(Promise.race([p.then(() => "settled"), flushAsync().then(() => "pending")])).resolves.toBe("pending")`.
- `LeaseInvariants` class (shared by load + soak): private `Set` of leased contexts; `onAcquire(ctx)` throws `"double-lease detected"` if already in the set, adds it, increments `acquired`, tracks `maxConcurrent`; `onRelease(ctx)` deletes + increments `released`; `assertQuiescent(capacity)` asserts set empty, `released === acquired`, `maxConcurrent <= capacity`.

Mock wiring at top of each mocked test file (`browser-pool.test.ts`, `browser-pool.load.test.ts`):
```ts
vi.mock("playwright-core", async () => {
    const { fakeChromium } = await import("./lib/fake-playwright.js");
    return { chromium: fakeChromium };
});
```
`beforeEach`: `vi.clearAllMocks(); resetFakePlaywright(); vi.unstubAllEnvs();`
Hygiene rule for every test: any intentionally-pending `acquire()` promise must have `.catch(() => {})` attached, and every test that leaves a pool open must `await pool.close()` at the end (its pending waiters reject — expected).

## Test cases (all must be implemented — this section is the authoritative checklist)

### File 1: `browser-pool.test.ts` — unit tests (mocked playwright-core)

Convention below: "pool A×B" = `new BrowserPool({ maxInstances: A, maxContextsPerBrowser: B })` followed by `await pool.launch()` unless the case says otherwise.

**`describe("launch")`**

1. **Pre-allocates full capacity and serves it all concurrently** — pool 2×3.
   - Assert `launchCalls.length === 2` and `launchedBrowsers.length === 2`.
   - Assert each fake browser has `newContextCalls === 3` (total 6 contexts created).
   - Call `acquire()` 6 times concurrently (`Promise.all`); all resolve; collect `lease.context` into a `Set` → size 6 (all distinct).
   - Call a 7th `acquire()` → `await expectPending(seventh)`.
   - Cleanup: `await pool.close()`; assert the 7th rejects with `"BrowserPool closed while waiting for a slot"`.

2. **Launch options: headless + hardening flags, no js-flags by default** — pool 1×1.
   - Assert `launchCalls[0].headless === true`.
   - Assert `launchCalls[0].args` contains each of: `--disable-dev-shm-usage`, `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-gpu`, `--disable-extensions`, `--disable-background-networking`, `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`.
   - Assert NO element of `args` starts with `--js-flags=`.

3. **`maxJsHeapSizeMb` adds the V8 heap flag** — pool 1×1 with `maxJsHeapSizeMb: 512`.
   - Assert `launchCalls[0].args` includes exactly `--js-flags=--max-old-space-size=512`.

4. **`PLAYWRIGHT_EXECUTABLE_PATH` is honored when set** — `vi.stubEnv("PLAYWRIGHT_EXECUTABLE_PATH", "/fake/chromium")`, then pool 1×1.
   - Assert `launchCalls[0].executablePath === "/fake/chromium"`.

5. **`executablePath` absent when env is unset** — ensure env var not set, pool 1×1.
   - Assert `!("executablePath" in launchCalls[0])` (property truly absent, not `undefined` — matters under `exactOptionalPropertyTypes`).

6. **Partial launch failure rolls back and rethrows** — `failLaunchOnCall(2, new Error("launch-2 failed"))`, pool 2×2, do NOT pre-launch.
   - Assert `await expect(pool.launch()).rejects.toThrow("launch-2 failed")`.
   - Assert `launchedBrowsers.length === 1` and `launchedBrowsers[0].connected === false` (browser 0 was closed during rollback).

7. **Bug C failing test — launch rollback must not spawn a zombie replacement** — `it.fails` + `// TODO(bug): partial-launch rollback triggers the crash handler and leaks a replacement browser`.
   - Same setup as #6 (`failLaunchOnCall(2)`, pool 2×2, `launch()` rejects).
   - `await flushAsync()`.
   - Assert correct behavior: `launchCalls.length === 2` (no third launch attempt) — currently fails because browser 0's rollback `close()` fires `disconnected`, the crash handler runs, and a zombie 3rd browser is launched in the background.

8. **Degenerate config: `maxInstances: 0`** — pool 0×5.
   - `launch()` resolves; `launchCalls.length === 0`.
   - `acquire()` pends forever (`expectPending`).
   - `close()` rejects the pending acquire with `"BrowserPool closed while waiting for a slot"`.

9. **Degenerate config: `maxContextsPerBrowser: 0`** — pool 2×0.
   - `launch()` resolves; `launchCalls.length === 2`; each browser `newContextCalls === 0`.
   - `acquire()` pends forever (`expectPending`); cleanup via `close()`.

**`describe("acquire")`**

10. **Never double-leases at capacity** — pool 2×2.
    - 4 concurrent `acquire()`s → all resolve; `Set` of the 4 contexts has size 4.
    - 2 more `acquire()`s → both pend (`expectPending` on `Promise.race` of them).
    - Cleanup: `close()`.

11. **Waiter queue is strictly FIFO** — pool 1×1.
    - `const lease = await pool.acquire()`.
    - Enqueue three acquires tagged A, B, C in order; each `.then()` pushes its tag into an `order: string[]` array.
    - `await lease.release()` → `await vi.waitFor(() => order.length === 1)`; release the lease A received; wait for `order.length === 2`; release B's lease; wait for 3.
    - Assert `order` deep-equals `["A", "B", "C"]`.
    - Cleanup: release C's lease, `close()`.

12. **`acquire()` after `close()` rejects immediately** — pool 1×1.
    - `await pool.close()`; then `await expect(pool.acquire()).rejects.toThrow("BrowserPool is closed")` (synchronous rejection path — no waiter enqueued).

**`describe("release")`**

13. **Recycles the context for isolation (destroy + fresh)** — pool 1×1.
    - `const lease = await pool.acquire()`; record `oldCtx = lease.context as FakeBrowserContext` and `callsBefore = browser.newContextCalls`.
    - `await lease.release()`.
    - Assert `oldCtx.closed === true` (dirty context destroyed).
    - Assert `browser.newContextCalls === callsBefore + 1` (fresh context created).
    - `const lease2 = await pool.acquire()` → assert `(lease2.context as FakeBrowserContext).id !== oldCtx.id`.

14. **Fresh context is handed directly to the next waiter, bypassing the free list** — pool 1×1.
    - Acquire the only lease; enqueue `waiter = pool.acquire()`.
    - `await lease.release()` → `waiter` resolves with a context whose `id` differs from the released one's.
    - Immediately enqueue another `acquire()` → it pends (`expectPending`) — proves the recycled context went straight to the waiter, never touching the free list.
    - Cleanup: release waiter's lease, `close()`.

15. **Returns to the free list when no waiters** — pool 1×1.
    - Acquire + release with no waiters queued.
    - A subsequent `acquire()` settles within a single `flushAsync()` (assert via `Promise.race` that it is "settled", the inverse of `expectPending`).

16. **`release()` after `close()` is a no-op** — pool 1×1.
    - Acquire; record `callsBefore = browser.newContextCalls` and the fake context.
    - `await pool.close()`; `await lease.release()` (resolves without throwing).
    - Assert `browser.newContextCalls === callsBefore` (no recycle) and the dirty fake context was NOT closed by release (its `closed` flag only reflects whatever `browser.close()` did to real Playwright — for the fake, assert release didn't call `ctx.close()`; give `FakeBrowserContext` a `closeCalls` counter to make this precise).

17. **Discard when browser crashed while lease was out (slot changed BEFORE cleanup)** — pool 1×1, `deferLaunchOnCall(2)` so the replacement stays pending.
    - Acquire the lease; `browser0.emitDisconnected()`; `await flushAsync()`.
    - Record `callsBefore = browser0.newContextCalls`, `closeCallsBefore = ctx.closeCalls`.
    - `await lease.release()` → returns early.
    - Assert `browser0.newContextCalls === callsBefore` and `ctx.closeCalls === closeCallsBefore` (release touched nothing on the dead browser).
    - Cleanup: resolve the deferred launch, `close()`.

18. **Discard when browser crashes DURING the async cleanup (slot changed mid-release)** — pool 1×1.
    - Acquire; set `ctx.closeGate = createDeferred()` so `context.close()` hangs.
    - Start `const rp = lease.release()` (do not await).
    - `browser0.emitDisconnected()`; `await flushAsync()` — the auto-replacement (launch call 2) succeeds and repopulates the free list with one fresh context.
    - Resolve `ctx.closeGate`; `await rp` (release now completes and hits the post-cleanup re-verify).
    - Assert the recycled old-browser context was discarded: a fresh `acquire()` resolves with a context created by `launchedBrowsers[1]` (check membership in `launchedBrowsers[1].contexts`), and after taking it, one more `acquire()` pends (capacity is exactly 1 — the old slot did not leak back in).
    - Cleanup: `close()`.

19. **`context.close()` error during recycle is swallowed; recycle proceeds** — pool 1×1.
    - Acquire; set `ctx.closeError = new Error("close boom")`.
    - `await lease.release()` (must not throw).
    - Assert `browser.newContextCalls` incremented and the next `acquire()` yields a fresh context (different `id`).

20. **Bug B failing test — failed recycle must not starve waiters** — `it.fails` + `// TODO(bug): newContext() failure during release silently discards the slot and strands queued waiters`.
    - Pool 1×1. Acquire; enqueue `waiter = pool.acquire()` (attach `.catch(() => {})`).
    - Set `browser.newContextError = new Error("boom")`.
    - `await lease.release()`.
    - Assert correct behavior: the waiter is eventually served (e.g., `await vi.waitFor(() => waiterResolved === true, { timeout: 2000 })` — recovery could come from relaunching the browser like the crash path does) — currently fails because the slot is silently dropped and the waiter hangs forever.
    - Cleanup: `close()` (rejects the stranded waiter in current behavior).

21. **Bug A failing test — double release must be idempotent** — `it.fails` + `// TODO(bug): release() has no idempotency guard; double release duplicates the slot and can double-lease one context`.
    - Pool 1×1. Acquire; record `callsBefore`.
    - `await lease.release(); await lease.release();`
    - Assert correct behavior: `browser.newContextCalls === callsBefore + 1` (recycled exactly once) AND exactly one subsequent `acquire()` resolves while a second one pends — currently fails: the second release recycles again (`callsBefore + 2`) and pushes the same managed-context object twice, so two acquires resolve, sharing state.
    - Cleanup: `close()`.

**`describe("crash handling")`**

22. **Crash purges that browser's free contexts; replacement repopulates and drains waiters** — pool 2×1, `deferLaunchOnCall(3)`.
    - Acquire both contexts (one per browser); enqueue `waiter = pool.acquire()`.
    - `browser0.emitDisconnected()`; `await flushAsync()` — replacement launch (call 3) is pending.
    - `await lease0.release()` → discarded (slot changed); assert waiter still pending (`expectPending`).
    - Resolve the deferred launch; `await vi.waitFor(...)` → waiter resolves; assert its context belongs to `launchedBrowsers[2]` (the replacement).
    - Assert the crashed browser's original free-context is never handed out (identity check on all leased contexts).
    - Cleanup: release everything, `close()`.

23. **Relaunch failure permanently reduces capacity but the pool keeps working** — pool 2×1, `failLaunchOnCall(3)`.
    - Do NOT acquire from browser 0 (its context is in the free list). `browser0.emitDisconnected()`; `await flushAsync()` (replacement attempt fails).
    - Two concurrent `acquire()`s → exactly one resolves (browser 1's context); the other pends (`expectPending`).
    - Full acquire/release cycle on the resolved lease works (release then re-acquire succeeds).
    - Cleanup: `close()` (pending acquire rejects).

24. **Crash after `close()` is ignored** — pool 1×1.
    - `await pool.close()`; record `n = launchCalls.length`.
    - `browser0.emitDisconnected()`; `await flushAsync()`.
    - Assert `launchCalls.length === n` (no replacement attempted).

25. **Replacement that finishes after `close()` is itself closed** — pool 1×1, `deferLaunchOnCall(2)`.
    - `browser0.emitDisconnected()` (replacement pending); `await pool.close()`.
    - Resolve the deferred launch.
    - `await vi.waitFor(() => launchedBrowsers[1].connected === false)` — the late replacement was immediately closed, not adopted.

**`describe("close")`**

26. **Rejects all pending waiters with the close message** — pool 1×1.
    - Acquire the lease; enqueue 3 waiters, collecting rejections via `.catch(err => errors.push(err.message))`.
    - `await pool.close()`; `await flushAsync()`.
    - Assert `errors` is exactly 3 × `"BrowserPool closed while waiting for a slot"`.
    - Assert all fake browsers received `close()` (`connected === false`).

27. **`Promise.allSettled` semantics: a browser whose close() throws doesn't break close()** — pool 2×1.
    - Set `launchedBrowsers[0].closeError = new Error("close failed")`.
    - `await pool.close()` resolves (does not throw).
    - Assert both browsers had `close()` invoked (give `FakeBrowser` a `closeCalls` counter; both ≥ 1).

28. **Double `close()` is safe** — pool 1×1.
    - `await pool.close(); await pool.close();` — both resolve, no throw.

29. **`close()` with leases outstanding resolves; late release no-ops** — pool 2×2.
    - Acquire 2 leases; `await pool.close()` resolves without waiting for them.
    - `await lease1.release(); await lease2.release();` — both resolve, no recycle happens (`newContextCalls` unchanged on both browsers after close).

### File 2: `browser-pool.load.test.ts` — mocked load/stress (ungated; runs in every `pnpm test`; target < 2 s wall time)

Shared setup: pool 4×8 (capacity 32); `LeaseInvariants` instance per test; deterministic PRNG — mulberry32 with a fixed literal seed (e.g. `0xdecafbad`), NO `Math.random` anywhere.

30. **Throughput/chaos: 5,000 tasks, waves of ~250** —
    - Fire tasks in waves: 20 waves × 250 tasks, `await Promise.all(wave)` between waves.
    - Each task: `const lease = await pool.acquire(); invariants.onAcquire(lease.context); for (let i = 0; i < prng() % 4; i++) await Promise.resolve(); invariants.onRelease(lease.context); await lease.release();`
    - Assert all 5,000 tasks resolved (counter === 5000).
    - `invariants.assertQuiescent(32)` — never a double-lease, `maxConcurrent <= 32`, everything released.
    - Cleanup: `close()`.

31. **FIFO fairness under saturation: 200 queued waiters served in exact order** —
    - Acquire all 32 leases and hold them.
    - Enqueue 200 tagged `acquire()`s; each `.then()` records its tag in `resolvedOrder`.
    - Release the 32 held leases one by one, then keep releasing each tagged lease as it resolves (chain releases until all 200 have resolved) — drive with `vi.waitFor` on `resolvedOrder.length === 200`.
    - Assert `resolvedOrder` deep-equals `[0, 1, ..., 199]` (exact enqueue order).
    - Cleanup: `close()`.

32. **Crash injection under load: 2,000 tasks with periodic browser crashes** —
    - Same task shape as #30 (waves of ~200).
    - Every ~200 completed tasks, `emitDisconnected()` on a PRNG-chosen browser whose `connected === true` (replacement launches auto-succeed — default fake behavior).
    - Assert: all 2,000 tasks complete (crashed-lease releases discard silently; waiters drain via replacements); `invariants.assertQuiescent(32)`.
    - Then assert full capacity restored: 32 concurrent `acquire()`s all resolve (`vi.waitFor` wrapped), then release all.
    - Cleanup: `close()`.

33. **Close under load: nothing hangs** —
    - Fire 500 tasks (same shape, `.then(ok).catch(err)` collectors); after ~half have been started, call `pool.close()` (do not await first).
    - `await Promise.allSettled(allTasks)` bounded by `vi.waitFor`/test timeout.
    - Assert every task settled and each failure message is one of exactly: `"BrowserPool is closed"` or `"BrowserPool closed while waiting for a slot"`.
    - Assert successes + failures === 500.

### File 3: `browser-pool.soak.test.ts` — real Chromium soak (gated; no `vi.mock`)

Gate: `const enabled = process.env.LOAD_TEST === "1" && !!process.env.PLAYWRIGHT_EXECUTABLE_PATH;` wrap in `describe.runIf(enabled)("BrowserPool soak (real Chromium)", ...)`.

34. **150-task soak on a 2×3 pool with isolation + memory checks** — single `it(..., 120_000)`:
    - `launch()` the pool inside the test; wrap the body in `try/finally` with `await pool.close()` in `finally`.
    - Run 150 tasks through a worker-queue pattern (natural concurrency = pool capacity 6). Each task:
      1. `const lease = await pool.acquire(); invariants.onAcquire(lease.context);`
      2. **Isolation check first**: `expect(await lease.context.cookies()).toEqual([])` — proves the previous holder's cookie dirt never leaks in.
      3. `const page = await lease.context.newPage(); await page.setContent("<h1>x</h1>"); await page.evaluate(() => document.title);`
      4. **Deliberately dirty the context**: `await lease.context.addCookies([{ name: "soak", value: "1", domain: "example.com", path: "/" }]);`
      5. `await page.close(); invariants.onRelease(lease.context); await lease.release();`
    - `invariants.assertQuiescent(6)`.
    - Memory: after the first 20 tasks record `heapUsed`; at the end record again; soft-assert growth < 150 MB (generous anti-flake bound); `console.log` final `rss`/`heapUsed` for human inspection.
    - No crash injection here (mocked tier covers crash paths; real browser handles aren't reachable black-box).

## Implementation order
1. `tests/package.json`: add playwright-core devDep + the two scripts; run `pnpm install` at repo root.
2. `tests/browser-workers/lib/fake-playwright.ts`.
3. `tests/browser-workers/browser-pool.test.ts` — bug tests A/B/C (#7, #20, #21) as `it.fails` with `// TODO(bug):` comments.
4. `tests/browser-workers/browser-pool.load.test.ts`.
5. `tests/browser-workers/browser-pool.soak.test.ts`.

## Verification
```bash
pnpm --filter @watchthatsite/tests test:browser-worker         # unit + mocked load (soak auto-skips)
pnpm --filter @watchthatsite/tests test:browser-worker:load    # soak still skips without Chromium
PLAYWRIGHT_EXECUTABLE_PATH="$(command -v chromium || echo '/Applications/Chromium.app/Contents/MacOS/Chromium')" \
  pnpm --filter @watchthatsite/tests test:browser-worker:load  # full soak, only if a system Chromium exists
pnpm --filter @watchthatsite/tests test                        # existing tests-package suites unaffected
```
Expected: suite green in a few seconds; the three `it.fails` bug tests (#7, #20, #21) pass *as* `it.fails` (their bodies fail against current code, proving the bugs). If an `it.fails` body unexpectedly passes, Vitest flags the test as failed — that means the pinned behavior was misdiagnosed and must be re-checked against browser-pool.ts (adjust the test, never the production code). Also sanity-check that `vi.mock("playwright-core")` intercepted the real module — implicit in case #1 (`launchCalls.length === 2`).

## Handover
Implementation is delegated to an agent with this plan as the authoritative spec. No changes to `browser-pool.ts` or any other production source. Every numbered case above (1–34) must exist as a distinct test (or `it.fails` test) — the implementing agent should tick them off one by one.
