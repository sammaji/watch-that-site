import { registrableDomain } from "../lib/validity.js";

/**
 * Where the Agent may take the browser while it records or repairs a Macro.
 *
 * The rule: the Agent may open, or click a link to, only
 * - the Monitor's own site (the same registrable domain as its URL), and
 * - a host the site itself sent the browser to during this session: an HTTP
 *   redirect, or the page navigating after a click or form submit on the
 *   site (how single sign-on reaches an identity provider).
 *
 * The Agent never widens the rule by asking: a URL it names, or an off-site
 * link it clicks, is refused. This matters because a watched page can carry
 * text that tries to steer the Agent elsewhere while it holds a signed-in
 * session and can type the owner's secrets.
 */
export class SiteScope {
    readonly home: string;
    private readonly redirectedTo = new Set<string>();

    constructor(monitorUrl: string) {
        this.home = registrableDomain(monitorUrl);
    }

    private static host(url: string): string {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch {
            return "";
        }
    }

    /** Whether the Agent may open `url`, or click a link or submit a form that goes there. */
    allows(url: string): boolean {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return false;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return false;
        }
        return (
            registrableDomain(url) === this.home ||
            this.redirectedTo.has(parsed.hostname.toLowerCase())
        );
    }

    /**
     * Records where the page ended up after an on-site action. A host the
     * site took the browser to becomes one the Agent may keep working on.
     */
    landedOn(url: string): void {
        const host = SiteScope.host(url);
        if (host !== "" && registrableDomain(url) !== this.home) {
            this.redirectedTo.add(host);
        }
    }

    /** Why `url` was refused, for the model. */
    refusal(url: string): string {
        const host = SiteScope.host(url) || url.slice(0, 60);
        return `That leaves the Monitor's site (${this.home}) for ${host}, which is not allowed. Stay on the site; other hosts are only reachable when the site itself redirects there.`;
    }
}
