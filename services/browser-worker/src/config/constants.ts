export const navigationTimeoutMs = 30000;

// Browser pool sizing.
// Each Chromium process uses ~100-200 MB RAM.
// Total max concurrent contexts = browserPoolInstances * contextsPerBrowser.
// Captures (prefetch 5), recordings (3) and Macro tests share the pool.
export const browserPoolInstances = 2;
export const contextsPerBrowser = 10;

// Hard limit on a captured screenshot. Matches the object store's own cap, so
// an oversized capture fails here with a clear message instead of a 413.
export const maxScreenshotBytes = 25 * 1024 * 1024;

// RabbitMQ topology.
export const jobQueue = "monitor_runs.scheduled";
export const jobWorkers = 5;

export const resultExchange = "monitor_runs";
export const resultRoutingKey = "monitor_scrape_result";

// Hard bound on one Capture without a Macro. Past it the context is closed
// and the Run fails with an error Capture instead of hanging.
export const captureDeadlineMs = 90_000;

// A Run that replays a Macro may also repair it: up to `maxRepairsPerRun`
// repairs of `repairLimits.wallClockMs` each, on top of the replay itself.
// This stays well under the scheduler's 15-minute stale-Run reaper and
// RabbitMQ's 30-minute delivery acknowledgement timeout.
export const macroCaptureDeadlineMs = 7 * 60_000;

// Macro replay.
export const defaultStepTimeoutMs = 10_000;
/** Recorded on optional steps, so a signed-in Run does not wait long for a sign-in form. */
export const optionalStepTimeoutMs = 3_000;
export const maxWaitStepMs = 30_000;
export const maxRepairsPerRun = 3;

// The agent API.
export const defaultAgentAddr = "127.0.0.1:5220";
export const maxRequestBytes = 20 * 1024 * 1024;

/** Limits of one agent job: model turns, actions on the page, wall clock. */
export type AgentLimits = {
    maxSteps: number;
    maxActions: number;
    wallClockMs: number;
};

export const compareLimits: AgentLimits = {
    maxSteps: 12,
    maxActions: 0,
    wallClockMs: 3 * 60_000,
};

export const planLimits: AgentLimits = {
    maxSteps: 12,
    maxActions: 0,
    wallClockMs: 3 * 60_000,
};

export const recordLimits: AgentLimits = {
    maxSteps: 60,
    maxActions: 30,
    wallClockMs: 5 * 60_000,
};

// A repair is one action: the one the broken step was for. With more, a
// model tends to carry on into the Macro's later steps, which replay then
// runs a second time.
export const repairLimits: AgentLimits = {
    maxSteps: 8,
    maxActions: 1,
    wallClockMs: 75_000,
};

/** Recordings running at once; more wait their turn. */
export const maxConcurrentRecordings = 3;

/** Longest side of an image sent to a model. Larger images are downscaled. */
export const maxModelImageSide = 1568;
