import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { BrowserPool } from "../../../services/browser-worker/src/lib/browser-pool.js";

const execFileAsync = promisify(execFile);

type Scenario = "short" | "long";

type Config = {
    scenario: Scenario;
    instances: number;
    contextsPerBrowser: number;
    concurrency: number;
    totalTasks: number | null;
    durationMs: number | null;
    sampleMs: number;
    pageKb: number;
    outputPath: string;
    budgets: {
        maxTreeRssMb: number | null;
        maxNodeRssGrowthMb: number | null;
        maxHeapGrowthMb: number | null;
        maxAcquireP99Ms: number | null;
    };
};

type MemorySample = {
    elapsedMs: number;
    active: number;
    completed: number;
    failed: number;
    nodeRssBytes: number;
    nodeHeapUsedBytes: number;
    nodeHeapTotalBytes: number;
    nodeExternalBytes: number;
    nodeArrayBuffersBytes: number;
    descendantsRssBytes: number;
    processTreeRssBytes: number;
    descendantCount: number;
};

type Percentiles = {
    count: number;
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
};

type MemoryStats = {
    startBytes: number;
    endBytes: number;
    peakBytes: number;
    growthBytes: number;
    peakGrowthBytes: number;
    maxSpikeBytes: number;
};

type ProfileResult = {
    config: Config;
    startedAt: string;
    endedAt: string;
    elapsedMs: number;
    totals: {
        completed: number;
        failed: number;
        throughputPerSec: number;
    };
    latencyMs: {
        acquire: Percentiles;
        lease: Percentiles;
        task: Percentiles;
    };
    memory: {
        nodeRss: MemoryStats;
        nodeHeapUsed: MemoryStats;
        descendantsRss: MemoryStats;
        processTreeRss: MemoryStats;
    };
    samples: MemorySample[];
    budgetFailures: string[];
};

type PsProcess = {
    pid: number;
    ppid: number;
    rssBytes: number;
};

function readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return parsed;
}

function readOptionalNumberEnv(name: string): number | null {
    const raw = process.env[name];
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return parsed;
}

function readScenario(): Scenario {
    const index = process.argv.indexOf("--scenario");
    const value = index === -1 ? process.env.PROFILE_SCENARIO : process.argv[index + 1];
    if (!value) return "short";
    if (value === "short" || value === "long") return value;
    throw new Error(`Unsupported scenario: ${value}`);
}

function makeConfig(): Config {
    const scenario = readScenario();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath =
        process.env.PROFILE_OUTPUT ??
        resolve(
            "browser-workers/load-results",
            `browser-pool-${scenario}-${timestamp}.json`,
        );

    const defaults =
        scenario === "short" ?
            {
                concurrency: 20,
                totalTasks: 100,
                durationMs: null,
                sampleMs: 250,
                pageKb: 16,
            }
        :   {
                concurrency: 20,
                totalTasks: null,
                durationMs: 10 * 60_000,
                sampleMs: 1_000,
                pageKb: 16,
            };

    const durationMs = readOptionalNumberEnv("PROFILE_DURATION_MS");
    const totalTasks = readOptionalNumberEnv("PROFILE_TOTAL_TASKS");

    return {
        scenario,
        instances: readNumberEnv("PROFILE_INSTANCES", 2),
        contextsPerBrowser: readNumberEnv("PROFILE_CONTEXTS_PER_BROWSER", 10),
        concurrency: readNumberEnv("PROFILE_CONCURRENCY", defaults.concurrency),
        totalTasks: totalTasks ?? defaults.totalTasks,
        durationMs: durationMs ?? defaults.durationMs,
        sampleMs: readNumberEnv("PROFILE_SAMPLE_MS", defaults.sampleMs),
        pageKb: readNumberEnv("PROFILE_PAGE_KB", defaults.pageKb),
        outputPath,
        budgets: {
            maxTreeRssMb: readOptionalNumberEnv("PROFILE_MAX_TREE_RSS_MB"),
            maxNodeRssGrowthMb: readOptionalNumberEnv(
                "PROFILE_MAX_NODE_RSS_GROWTH_MB",
            ),
            maxHeapGrowthMb: readOptionalNumberEnv("PROFILE_MAX_HEAP_GROWTH_MB"),
            maxAcquireP99Ms: readOptionalNumberEnv("PROFILE_MAX_ACQUIRE_P99_MS"),
        },
    };
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.ceil((p / 100) * sorted.length) - 1,
    );
    return sorted[index]!;
}

function percentiles(values: number[]): Percentiles {
    if (values.length === 0) {
        return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    return {
        count: values.length,
        min: Math.min(...values),
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        max: Math.max(...values),
    };
}

function memoryStats(samples: MemorySample[], key: keyof MemorySample): MemoryStats {
    const values = samples.map(sample => Number(sample[key]));
    const startBytes = values[0] ?? 0;
    const endBytes = values.at(-1) ?? 0;
    const peakBytes = Math.max(...values, 0);
    let maxSpikeBytes = 0;
    for (let i = 1; i < values.length; i++) {
        maxSpikeBytes = Math.max(maxSpikeBytes, values[i]! - values[i - 1]!);
    }

    return {
        startBytes,
        endBytes,
        peakBytes,
        growthBytes: endBytes - startBytes,
        peakGrowthBytes: peakBytes - startBytes,
        maxSpikeBytes,
    };
}

function bytesToMb(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function msSince(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1_000_000;
}

async function readProcessTable(): Promise<PsProcess[]> {
    try {
        const { stdout } = await execFileAsync("ps", [
            "-axo",
            "pid=,ppid=,rss=",
        ]);
        return stdout
            .trim()
            .split("\n")
            .flatMap(line => {
                const [pidRaw, ppidRaw, rssRaw] = line.trim().split(/\s+/);
                const pid = Number(pidRaw);
                const ppid = Number(ppidRaw);
                const rssKb = Number(rssRaw);
                if (
                    !Number.isFinite(pid) ||
                    !Number.isFinite(ppid) ||
                    !Number.isFinite(rssKb)
                ) {
                    return [];
                }
                return [{ pid, ppid, rssBytes: rssKb * 1024 }];
            });
    } catch {
        return [];
    }
}

async function sampleMemory(
    start: bigint,
    active: number,
    completed: number,
    failed: number,
): Promise<MemorySample> {
    const mem = process.memoryUsage();
    const processes = await readProcessTable();
    const childrenByParent = new Map<number, PsProcess[]>();
    for (const proc of processes) {
        const children = childrenByParent.get(proc.ppid) ?? [];
        children.push(proc);
        childrenByParent.set(proc.ppid, children);
    }

    const descendants: PsProcess[] = [];
    const stack = [...(childrenByParent.get(process.pid) ?? [])];
    while (stack.length > 0) {
        const next = stack.pop()!;
        descendants.push(next);
        stack.push(...(childrenByParent.get(next.pid) ?? []));
    }

    const descendantsRssBytes = descendants.reduce(
        (sum, proc) => sum + proc.rssBytes,
        0,
    );

    return {
        elapsedMs: msSince(start),
        active,
        completed,
        failed,
        nodeRssBytes: mem.rss,
        nodeHeapUsedBytes: mem.heapUsed,
        nodeHeapTotalBytes: mem.heapTotal,
        nodeExternalBytes: mem.external,
        nodeArrayBuffersBytes: mem.arrayBuffers,
        descendantsRssBytes,
        processTreeRssBytes: mem.rss + descendantsRssBytes,
        descendantCount: descendants.length,
    };
}

function buildHtml(pageKb: number, taskId: number): string {
    const bytes = pageKb * 1024;
    const chunk = `task-${taskId}-`.padEnd(128, "x");
    const repeats = Math.max(1, Math.ceil(bytes / chunk.length));
    return `<html><body><main>${chunk.repeat(repeats)}</main></body></html>`;
}

async function runProfile(config: Config): Promise<ProfileResult> {
    if (!process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
        throw new Error(
            "PLAYWRIGHT_EXECUTABLE_PATH is required because playwright-core does not bundle Chromium",
        );
    }

    const pool = new BrowserPool({
        maxInstances: config.instances,
        maxContextsPerBrowser: config.contextsPerBrowser,
    });

    const acquireLatencies: number[] = [];
    const leaseLatencies: number[] = [];
    const taskLatencies: number[] = [];
    const samples: MemorySample[] = [];
    const startedAt = new Date();
    const start = process.hrtime.bigint();
    let active = 0;
    let completed = 0;
    let failed = 0;
    let loggedFailures = 0;
    let nextTaskId = 0;
    let stop = false;
    let sampler: NodeJS.Timeout | null = null;

    await pool.launch();

    try {
        samples.push(await sampleMemory(start, active, completed, failed));
        sampler = setInterval(() => {
            void sampleMemory(start, active, completed, failed).then(sample => {
                samples.push(sample);
            });
        }, config.sampleMs);

        if (config.durationMs !== null) {
            setTimeout(() => {
                stop = true;
            }, config.durationMs).unref();
        }

        const runTask = async (taskId: number): Promise<void> => {
            const taskStart = process.hrtime.bigint();
            const acquireStart = process.hrtime.bigint();
            const lease = await pool.acquire();
            acquireLatencies.push(msSince(acquireStart));
            active++;

            const leaseStart = process.hrtime.bigint();
            let page: Awaited<ReturnType<typeof lease.context.newPage>> | null = null;
            try {
                page = await lease.context.newPage();
                await page.setContent(buildHtml(config.pageKb, taskId));
                await page.evaluate(() => document.body.innerText.length);
                await lease.context.addCookies([
                    {
                        name: "profile",
                        value: String(taskId),
                        domain: "example.com",
                        path: "/",
                    },
                ]);
                completed++;
            } catch (err) {
                failed++;
                throw err;
            } finally {
                await page?.close().catch(() => undefined);
                leaseLatencies.push(msSince(leaseStart));
                active--;
                await lease.release();
                taskLatencies.push(msSince(taskStart));
            }
        };

        const runWorker = async (): Promise<void> => {
            while (!stop) {
                const taskId = nextTaskId++;
                if (config.totalTasks !== null && taskId >= config.totalTasks) {
                    return;
                }
                try {
                    await runTask(taskId);
                } catch (err) {
                    if (loggedFailures < 5) {
                        loggedFailures++;
                        console.warn(
                            "BrowserPool profile task failed",
                            err instanceof Error ? err.message : String(err),
                        );
                    }
                }
            }
        };

        await Promise.all(
            Array.from({ length: config.concurrency }, () => runWorker()),
        );
    } finally {
        if (sampler) clearInterval(sampler);
        samples.push(await sampleMemory(start, active, completed, failed));
        await pool.close();
    }

    const endedAt = new Date();
    const elapsedMs = endedAt.getTime() - startedAt.getTime();
    const result: ProfileResult = {
        config,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        elapsedMs,
        totals: {
            completed,
            failed,
            throughputPerSec: completed / (elapsedMs / 1_000),
        },
        latencyMs: {
            acquire: percentiles(acquireLatencies),
            lease: percentiles(leaseLatencies),
            task: percentiles(taskLatencies),
        },
        memory: {
            nodeRss: memoryStats(samples, "nodeRssBytes"),
            nodeHeapUsed: memoryStats(samples, "nodeHeapUsedBytes"),
            descendantsRss: memoryStats(samples, "descendantsRssBytes"),
            processTreeRss: memoryStats(samples, "processTreeRssBytes"),
        },
        samples,
        budgetFailures: [],
    };

    result.budgetFailures = checkBudgets(result);
    return result;
}

function checkBudgets(result: ProfileResult): string[] {
    const failures: string[] = [];
    const { budgets } = result.config;

    if (
        budgets.maxTreeRssMb !== null &&
        bytesToMb(result.memory.processTreeRss.peakBytes) > budgets.maxTreeRssMb
    ) {
        failures.push(
            `process-tree RSS peak ${bytesToMb(result.memory.processTreeRss.peakBytes)} MB exceeded ${budgets.maxTreeRssMb} MB`,
        );
    }
    if (
        budgets.maxNodeRssGrowthMb !== null &&
        bytesToMb(result.memory.nodeRss.growthBytes) > budgets.maxNodeRssGrowthMb
    ) {
        failures.push(
            `node RSS growth ${bytesToMb(result.memory.nodeRss.growthBytes)} MB exceeded ${budgets.maxNodeRssGrowthMb} MB`,
        );
    }
    if (
        budgets.maxHeapGrowthMb !== null &&
        bytesToMb(result.memory.nodeHeapUsed.growthBytes) > budgets.maxHeapGrowthMb
    ) {
        failures.push(
            `heap growth ${bytesToMb(result.memory.nodeHeapUsed.growthBytes)} MB exceeded ${budgets.maxHeapGrowthMb} MB`,
        );
    }
    if (
        budgets.maxAcquireP99Ms !== null &&
        result.latencyMs.acquire.p99 > budgets.maxAcquireP99Ms
    ) {
        failures.push(
            `acquire p99 ${Math.round(result.latencyMs.acquire.p99)} ms exceeded ${budgets.maxAcquireP99Ms} ms`,
        );
    }

    return failures;
}

async function writeResult(result: ProfileResult): Promise<void> {
    await mkdir(dirname(result.config.outputPath), { recursive: true });
    await writeFile(result.config.outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

function logSummary(result: ProfileResult): void {
    const summary = {
        scenario: result.config.scenario,
        elapsedSec: Math.round(result.elapsedMs / 100) / 10,
        completed: result.totals.completed,
        failed: result.totals.failed,
        throughputPerSec: Math.round(result.totals.throughputPerSec * 10) / 10,
        acquireP99Ms: Math.round(result.latencyMs.acquire.p99),
        taskP99Ms: Math.round(result.latencyMs.task.p99),
        nodeRss: {
            startMb: bytesToMb(result.memory.nodeRss.startBytes),
            peakMb: bytesToMb(result.memory.nodeRss.peakBytes),
            endMb: bytesToMb(result.memory.nodeRss.endBytes),
            maxSpikeMb: bytesToMb(result.memory.nodeRss.maxSpikeBytes),
        },
        processTreeRss: {
            startMb: bytesToMb(result.memory.processTreeRss.startBytes),
            peakMb: bytesToMb(result.memory.processTreeRss.peakBytes),
            endMb: bytesToMb(result.memory.processTreeRss.endBytes),
            maxSpikeMb: bytesToMb(result.memory.processTreeRss.maxSpikeBytes),
        },
        outputPath: result.config.outputPath,
        budgetFailures: result.budgetFailures,
    };

    console.log(JSON.stringify(summary, null, 2));
}

async function main(): Promise<void> {
    const config = makeConfig();
    const result = await runProfile(config);
    await writeResult(result);
    logSummary(result);

    if (result.budgetFailures.length > 0) {
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
