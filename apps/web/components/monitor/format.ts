import type {
    MacroOutcome,
    Magnitude,
    RunVerdict,
    SuppressionReason,
    Urgency,
} from "@watchthatsite/types";

/**
 * Copy and formatting shared by the Monitor, Run and Change screens.
 */

/** What each verdict is called on screen. */
export const VERDICT_LABEL: Record<RunVerdict, string> = {
    baseline: "Baseline",
    none: "No difference",
    noise: "Not reported",
    pending: "Waiting to confirm",
    change: "Change",
};

/** Why a difference was recorded but not reported, as a full sentence. */
export const SUPPRESSION_COPY: Record<SuppressionReason, string> = {
    not_relevant: "It did not match your instructions.",
    did_not_persist: "It was gone again on the next check.",
    ignored_section: "Only ignored sections changed.",
};

export function suppressionCopy(reason: string): string {
    return (
        SUPPRESSION_COPY[reason as SuppressionReason] ??
        `${reason.replace(/_/g, " ")}.`
    );
}

/** Why a Capture was rejected, for the owner. */
const INVALID_REASON_COPY: Record<string, string> = {
    http_status: "The page answered with an error.",
    challenge: "The site asked to prove we are not a robot.",
    empty: "The page came back empty.",
    blank_screenshot: "The page rendered blank.",
    cross_domain: "The page redirected to another site.",
    macro_failed:
        "Pre-scraping could not finish, so the page was not captured.",
    partial: "The page did not finish loading.",
};

export function invalidReasonCopy(reason: string): string {
    return INVALID_REASON_COPY[reason] ?? `${reason.replace(/_/g, " ")}.`;
}

export const MACRO_STATUS_LABEL: Record<MacroOutcome, string> = {
    ok: "Pre-scraping replayed",
    repaired: "Pre-scraping repaired",
    failed: "Pre-scraping failed",
};

export const URGENCY_LABEL: Record<Urgency, string> = {
    instant: "Right away",
    hourly: "In an hourly digest",
    daily: "In a daily digest",
};

export const RUN_KIND_LABEL: Record<string, string> = {
    schedule: "Scheduled",
    manual: "Run now",
    confirm: "Confirming a Change",
};

function pct(ratio: number): string {
    const value = ratio * 100;
    if (value > 0 && value < 0.1) return "<0.1 %";
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} %`;
}

/** "+3 −1 words · 1.2 % of the page", or "" when there is nothing to show. */
export function magnitudeLabel(
    m: Partial<Magnitude> | null | undefined,
): string {
    if (!m) return "";
    const parts: string[] = [];
    const added = m.words_added ?? 0;
    const removed = m.words_removed ?? 0;
    if (added || removed) {
        const words: string[] = [];
        if (added) words.push(`+${added}`);
        if (removed) words.push(`−${removed}`);
        parts.push(
            `${words.join(" ")} word${added + removed === 1 ? "" : "s"}`,
        );
    } else if (m.moves) {
        parts.push(`${m.moves} moved`);
    }
    if (m.area_ratio && m.area_ratio > 0)
        parts.push(`${pct(m.area_ratio)} of the page`);
    return parts.join(" · ");
}

/** "12.4k tokens", or "" when the Run made no model call. */
export function formatTokens(
    input: number | null | undefined,
    output: number | null | undefined,
): string {
    const total = (input ?? 0) + (output ?? 0);
    if (total <= 0) return "";
    if (total < 1_000) return `${total} tokens`;
    const k = total / 1_000;
    return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k tokens`;
}

export function formatCount(n: number): string {
    return n.toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1_000) return `${Math.round(ms)} ms`;
    const s = ms / 1_000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
    const m = Math.floor(s / 60);
    return `${m} min ${Math.round(s % 60)} s`;
}

export function formatDateTime(value: string): string {
    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(value));
}

export function formatInterval(minutes: number | null): string {
    if (minutes == null) return "Only when you run it";
    if (minutes < 60) return `Every ${minutes} min`;
    if (minutes < 1440) {
        const h = minutes / 60;
        return h === 1 ? "Every hour" : `Every ${h} hours`;
    }
    const days = minutes / 1440;
    return days === 1 ? "Every day" : `Every ${days} days`;
}
