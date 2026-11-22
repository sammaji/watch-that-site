import type { InvalidReason } from "@watchthatsite/types";
import { getDomain } from "tldts";

/**
 * Validity checks on what the page load returned. An invalid
 * Capture is a typed failure the scheduler never compares, so an outage or a
 * bot wall does not become a Change.
 *
 * Checked here, in this order:
 * 1. `challenge`: a bot-protection page. Checked before the status because
 *    challenge pages usually arrive as 403 or 503, and "blocked by a bot wall"
 *    is the more useful reason.
 * 2. `http_status`: the final response is 400 or above.
 * 3. `cross_domain`: the final URL is on a different registrable domain.
 *
 * `empty` and `blank_screenshot` need the rendered page and are checked by the
 * capture orchestrator, which also reports `macro_failed`. The partial-load
 * check needs the Baseline and lives in the scheduler.
 */

export type ResponseSignals = {
    status: number;
    /** The URL navigated to (after any proxy rewrite). */
    requestedUrl: string;
    finalUrl: string;
    title: string;
    /** Rendered body text; only the first few kB matter. */
    bodyText: string;
    /** Serialized HTML, for script and form markers. */
    html: string;
    /** Response headers of the main document, lower-cased names. */
    headers: Record<string, string>;
};

const challengeTitles: RegExp[] = [
    /^just a moment\.{0,3}$/i, // Cloudflare managed challenge
    /attention required!? \| cloudflare/i, // Cloudflare block page
    /^access denied$/i, // Akamai
    /^pardon our interruption/i, // Imperva / Distil
    /datadome/i,
];

const challengeBody: RegExp[] = [
    /checking (if the site connection is secure|your browser before accessing)/i,
    /enable javascript and cookies to continue/i, // Cloudflare
    /you don't have permission to access .* on this server/i, // Akamai
    /press\s*(&|and)\s*hold/i, // PerimeterX / HUMAN
    /please verify you are a human/i,
];

const challengeHtml: RegExp[] = [
    /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform|__cf_chl_/i,
    /captcha-delivery\.com/i, // DataDome
    /id=["']px-captcha["']|perimeterx|\/_px\w*\/captcha/i, // PerimeterX
];

/** Whether the load looks like a bot-protection page. */
export function isChallenge(s: ResponseSignals): boolean {
    if (s.headers["cf-mitigated"]) return true;
    // DataDome sets x-datadome on every protected response; only a rejected
    // one is a challenge.
    if (s.headers["x-datadome"] && s.status >= 400) return true;

    const title = s.title.trim();
    if (challengeTitles.some(re => re.test(title))) return true;
    const body = s.bodyText.slice(0, 5000);
    if (challengeBody.some(re => re.test(body))) return true;
    const html = s.html.slice(0, 200_000);
    return challengeHtml.some(re => re.test(html));
}

/**
 * The registrable domain ("eTLD+1") of a URL, falling back to the hostname
 * for IPs, localhost and other hosts without a public suffix.
 */
export function registrableDomain(url: string): string {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return "";
    }
    return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

export function isCrossDomain(requestedUrl: string, finalUrl: string): boolean {
    if (!finalUrl) return false;
    return registrableDomain(requestedUrl) !== registrableDomain(finalUrl);
}

/**
 * The first invalid reason the response signals show, or null.
 *
 * `allowCrossDomain` is set when a Macro ran: it may legitimately end on
 * another host (a hosted billing portal, a single sign-on landing page).
 */
export function checkResponse(
    s: ResponseSignals,
    opts: { allowCrossDomain?: boolean } = {},
): InvalidReason | null {
    if (isChallenge(s)) return "challenge";
    if (s.status >= 400) return "http_status";
    if (!opts.allowCrossDomain && isCrossDomain(s.requestedUrl, s.finalUrl)) {
        return "cross_domain";
    }
    return null;
}
