/**
 * The messages and HTTP bodies the services exchange.
 *
 *   scheduler  --ScrapeJob (AMQP)-->  browser worker
 *   scheduler  <--Capture (AMQP)----  browser worker
 *   scheduler  --CompareRequest, PlanRequest (HTTP)-->  browser worker's agent API
 *   web app    --RecordMacroRequest, TestMacroRequest (HTTP)-->  agent API
 *
 * The Go side mirrors these in services/scheduler/internal/db/types.go
 * (ScrapeJob), internal/capture/capture.go (Capture) and
 * internal/agentclient (Compare*). Go decodes Capture strictly
 * (DisallowUnknownFields), so a field added here must be added there.
 *
 * The agent API listens on AGENT_ADDR (default 127.0.0.1:5220) and requires
 * `Authorization: Bearer $AGENT_TOKEN` on every route but /internal/health.
 */

import type {
    ChangeItem,
    IgnoredItem,
    Importance,
    RunRef,
    TextSection,
} from "./change-record";
import type { MacroStep } from "./macro";
import type { Rect } from "./monitor-config";
import type { WatchHow, WatchPlan, WatchSection } from "./watch-plan";

// ---------------------------------------------------------------------------
// ScrapeJob v3 (scheduler -> browser worker, routing key monitor_scrape_job)
// ---------------------------------------------------------------------------

export type ScreenshotFormat = "webp" | "png";

export interface CaptureOptions {
    screenshot: ScreenshotFormat;
    full_page: boolean;
    max_height: number;
    extra_wait_ms: number;
    block_ads: boolean;
    block_cookie_banners: boolean;
}

export interface ScrapeJob {
    version: 3;
    run_id: string;
    monitor_id: string;
    url: string;
    viewport: { w: number; h: number };
    capture: CaptureOptions;
    /**
     * The active Macro version to replay before the Capture, or null. The
     * worker loads its steps (and the Monitor's secrets, connection and model,
     * which it needs for a repair) from Postgres.
     */
    macro_id: string | null;
    /** `state/{monitor_id}.json`, or null to start without a saved session. */
    storage_state_key: string | null;
    env_version: string;
}

// ---------------------------------------------------------------------------
// Capture v3 (browser worker -> scheduler, routing key monitor_scrape_result)
// ---------------------------------------------------------------------------

export type CaptureStatus = "ok" | "invalid" | "error";

/** `partial` is set by the scheduler, never by the worker. */
export type InvalidReason =
    | "http_status"
    | "challenge"
    | "empty"
    | "blank_screenshot"
    | "cross_domain"
    | "macro_failed";

/** One visible block-level element of the rendered page. */
export interface Block {
    id: string;
    path: string;
    tag: string;
    text: string;
    rect: Rect;
}

export interface Screenshot {
    key: string;
    w: number;
    h: number;
    format: ScreenshotFormat;
}

export interface CaptureMeta {
    http_status: number;
    final_url: string;
    title: string;
    stable: boolean;
    /** Whether the network went quiet (500 ms without requests) before its 10 s cap. */
    network_quiet: boolean;
    env_version: string;
    timings_ms: { load: number; settle: number; total: number };
}

export type MacroOutcome = "ok" | "repaired" | "failed";

/** How the Macro replay went. Null on the Capture when the job had no Macro. */
export interface MacroResult {
    /** The version the job asked for. */
    macro_id: string;
    status: MacroOutcome;
    /** Index of the step that failed and could not be repaired, else null. */
    failed_step: number | null;
    /**
     * When status is `repaired`: the new active version the worker inserted.
     * Later Runs replay it.
     */
    repaired_macro_id: string | null;
    /** Model usage of the repair, zero when none was needed. */
    input_tokens: number;
    output_tokens: number;
}

/**
 * Every top-level field is always present; `null` stands in for a Go pointer
 * that does not apply.
 */
export interface Capture {
    version: 3;
    run_id: string;
    monitor_id: string;
    status: CaptureStatus;
    invalid_reason: InvalidReason | null;
    error: { message: string } | null;
    blocks: Block[];
    truncated: boolean;
    screenshot: Screenshot | null;
    /** Regions that kept changing between two frames (animation, video). */
    masks: Rect[];
    meta: CaptureMeta;
    macro: MacroResult | null;
}

// ---------------------------------------------------------------------------
// POST /internal/compare (scheduler -> agent API)
//
// The scheduler has already diffed the two Captures. The agent reads the
// Monitor's instructions and the evidence, may look closer (read more of
// either page's text, view a region of either screenshot), and answers.
// It writes its steps to run_steps (phase `compare`) as it goes.
// ---------------------------------------------------------------------------

export interface CompareRegion {
    /**
     * Where the region is on the new screenshot. For an area that exists on
     * the previous screenshot only (`removed_band`, or `extra_width` with a
     * `from_box`), where it was on the previous one.
     */
    box: Rect;
    /**
     * Where the same area is on the previous screenshot, which differs from
     * `box` whenever content above it moved. Null when the area exists on the
     * new screenshot only.
     */
    from_box: Rect | null;
    kind: string;
    pixels: number;
    /** Id of the Watch Plan Section the region lies in, "" outside every Section. */
    section: string;
}

export interface CompareRequest {
    run_id: string;
    monitor_id: string;
    user_id: string;
    monitor: { name: string; url: string; instructions: string };
    /** Null when the Monitor has none: the agent answers `unavailable`. */
    connection_id: string | null;
    model: string | null;
    from: RunRef;
    to: RunRef;
    /** The text diff, previous Capture -> this one. Items cite `ops` by index. */
    text: TextSection | null;
    /**
     * Changed screenshot regions, from Sections watched as visual or both
     * (or the whole page when there is no plan). Items cite them by index.
     */
    regions: CompareRegion[];
    /**
     * The Monitor's Watch Plan, so the Agent knows which Section each
     * difference is in and how the owner wanted it watched. Differences in
     * ignored Sections have already been removed by the scheduler.
     */
    plan: WatchPlan | null;
    /** Screenshot sizes `[w, h]`, zero when there is no screenshot. */
    size_before: [number, number];
    size_after: [number, number];
    /** The owner's feedback on recent Changes of this Monitor, newest first. */
    feedback: { summary: string; feedback: "useful" | "noise" }[];
}

export interface CompareItem {
    title: string;
    before: string;
    after: string;
    kind: ChangeItem["kind"];
    matches: string;
    /** Indexes into CompareRequest.text.ops. */
    ops: number[];
    /** Indexes into CompareRequest.regions. */
    regions: number[];
}

export interface CompareResponse {
    /** Does the difference match what the owner asked to be told about? */
    relevant: boolean;
    importance: Importance;
    /** One sentence, written for the owner. */
    summary: string;
    items: CompareItem[];
    ignored: IgnoredItem[];
    model: string;
    input_tokens: number;
    output_tokens: number;
    steps: number;
}

// ---------------------------------------------------------------------------
// POST /internal/plan (scheduler -> agent API)
//
// Called when a Monitor gets a Baseline, when its Instructions change, and
// when its Sections stop matching the page. The Agent reads the Instructions,
// the page's block outline (each block's path, tag, text and rectangle, from
// the Capture's blocks.json.gz) and its screenshot, and answers with the
// Sections and how each should be watched. It writes its steps to run_steps
// (phase `plan`).
// ---------------------------------------------------------------------------

/** How a Capture's page loaded, as the plan job is told it. */
export interface PlanLoad {
    /** Navigation to the `load` event. */
    load_ms: number;
    /** From `load` to the screenshot: network quiet, lazy-load scrolling, the wait. */
    settle_ms: number;
    /** The network went quiet before its 10 s cap. */
    network_quiet: boolean;
    /** Two screenshots in a row matched. */
    stable: boolean;
    /** Regions that still moved between the two screenshots. */
    moving_regions: number;
    /** The extra wait this Capture already had. */
    wait_ms: number;
}

export interface PlanRequest {
    run_id: string;
    monitor_id: string;
    user_id: string;
    monitor: { name: string; url: string; instructions: string };
    connection_id: string | null;
    model: string | null;
    /** The Capture to plan from. */
    capture: RunRef;
    /** Screenshot size `[w, h]`, zero when there is no screenshot. */
    size: [number, number];
    /** How the page loaded for this Capture, for deciding the wait. */
    load: PlanLoad | null;
    /**
     * The plan being replaced, if any, so Section ids and the owner's manual
     * choices carry over where the Section is still there.
     */
    previous: WatchPlan | null;
}

export interface PlanResponse {
    sections: WatchSection[];
    rest: WatchHow;
    summary: string;
    /** Extra milliseconds to wait before each Capture: the page is still filling in. */
    wait_ms: number;
    model: string;
    input_tokens: number;
    output_tokens: number;
    steps: number;
}

// ---------------------------------------------------------------------------
// POST /internal/suggest (web app -> agent API)
//
// While the owner fills in the Monitor form: open the URL in a browser, read
// the page, and have the owner's utility model propose a few Instructions that
// fit this page. Waits for the answer.
// ---------------------------------------------------------------------------

export interface SuggestRequest {
    user_id: string;
    url: string;
}

export interface SuggestResponse {
    /** Three or four Instructions, in the owner's voice, for this page. */
    suggestions: string[];
    /** The page's title as rendered: the Monitor's name by default. */
    title: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
}

/** Error body of every agent API route. */
export interface AgentError {
    error: {
        /**
         * no_connection: the Monitor has no usable model connection.
         * provider_error: the model call failed (bad key, rate limit, outage).
         * bad_request, not_found, unauthorized, internal_error.
         */
        code: string;
        message: string;
    };
}

// ---------------------------------------------------------------------------
// POST /internal/macros/record (web app -> agent API)
//
// The agent opens the Monitor's URL in a fresh browser and works towards the
// goal. Every action it takes becomes a Macro step. Returns at once; the
// macros row goes recording -> draft | failed, and run_steps rows (phase
// `record`) appear as it works, which the web app polls.
// ---------------------------------------------------------------------------

export interface RecordMacroRequest {
    monitor_id: string;
    /** "Sign in, open Billing, switch to Annual". */
    goal: string;
}

export interface RecordMacroResponse {
    macro_id: string;
}

// ---------------------------------------------------------------------------
// POST /internal/macros/test (web app -> agent API)
//
// Replays steps once in a fresh browser without a model, so the owner can
// check an edited Macro. Waits for the replay to finish.
// ---------------------------------------------------------------------------

export interface TestMacroRequest {
    monitor_id: string;
    steps: MacroStep[];
}

export interface TestMacroResponse {
    ok: boolean;
    /** Index of the step that failed, else null. */
    failed_step: number | null;
    error: string;
    /** One entry per step that was reached, in order; replay stops at the first failure. */
    steps: {
        status: "ok" | "failed" | "skipped";
        /** The selector that matched, when the step has selectors. */
        selector: string | null;
        error: string;
        duration_ms: number;
    }[];
    /** Object key of a screenshot taken after the last step that ran. */
    screenshot_key: string | null;
}

// ---------------------------------------------------------------------------
// Object keys
// ---------------------------------------------------------------------------

/** Screenshot taken after step `seq` of a Run or a recording. */
export function stepScreenshotKey(
    monitorId: string,
    subjectId: string,
    seq: number,
): string {
    return `steps/${monitorId}/${subjectId}/${seq}.webp`;
}
