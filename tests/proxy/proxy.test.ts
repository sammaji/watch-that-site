import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeUrlUtils } = require("../../services/proxy/runtime.js") as {
    makeUrlUtils: (opts: { proxyPrefix: string; getOrigin?: () => string }) => {
        isSpecialProtocol: (url: string) => boolean;
        inferTargetUrl: (candidate: string) => URL | null;
        toTargetUrl: (input: string, base?: string) => string | null;
        toProxyUrl: (input: string, base?: string) => string | null;
    };
};

const PREFIX = "/api/v1/proxy";
const ORIGIN = "http://localhost:3000";

function utils() {
    return makeUrlUtils({ proxyPrefix: PREFIX, getOrigin: () => ORIGIN });
}

describe("isSpecialProtocol", () => {
    it.each([
        ["data:image/png;base64,abc", true],
        ["blob:https://example.com/abc", true],
        ["javascript:void(0)", true],
        ["mailto:user@example.com", true],
        ["tel:+1234567890", true],
        ["about:blank", true],
        ["https://example.com", false],
        ["http://example.com", false],
        ["/relative/path", false],
        ["", false],
    ])("%s → %s", (url, expected) => {
        expect(utils().isSpecialProtocol(url)).toBe(expected);
    });
});

describe("inferTargetUrl", () => {
    it("unwraps https proxy URL", () => {
        const candidate = `${PREFIX}/https/example.com`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe("https://example.com/");
    });

    it("unwraps http proxy URL", () => {
        const candidate = `${PREFIX}/http/example.com`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe("http://example.com/");
    });

    it("unwraps https with www. in proxy URL", () => {
        const candidate = `${PREFIX}/http/www.example.com`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe("http://www.example.com/");
    });

    it("unwraps proxy URL with path and search params", () => {
        const candidate = `${PREFIX}/http/example.com/path?q=1`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe("http://example.com/path?q=1");
    });

    it("unwraps absolute proxy URL with origin prefix", () => {
        const candidate = `${ORIGIN}${PREFIX}/https/example.com/path`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe("https://example.com/path");
    });

    it("unwraps absolute proxy URL with origin prefix with ids", () => {
        const candidate = `${ORIGIN}${PREFIX}/https/example.com/path#id`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe("https://example.com/path#id");
    });

    it("preserves query string", () => {
        const candidate = `${PREFIX}/https/example.com/search?q=hello&page=2`;
        const result = utils().inferTargetUrl(candidate);
        expect(result?.toString()).toBe(
            "https://example.com/search?q=hello&page=2",
        );
    });

    describe("trailing slash cases", () => {
        it("unwraps proxy URL with trailing slash", () => {
            const candidate = `${PREFIX}/http/example.com/`;
            const result = utils().inferTargetUrl(candidate);
            expect(result?.toString()).toBe("http://example.com/");
        });

        it("unwraps proxy URL with path params ending in trailing slash", () => {
            const candidate = `${PREFIX}/http/example.com/`;
            const result = utils().inferTargetUrl(candidate);
            expect(result?.toString()).toBe("http://example.com/");
        });

        it("unwraps proxy URL with search params ending in trailing slash", () => {
            const candidate = `${PREFIX}/http/example.com/path?q=1/`;
            const result = utils().inferTargetUrl(candidate);
            expect(result?.toString()).toBe("http://example.com/path?q=1/");
        });

        it("unwraps absolute proxy URL with origin prefix with ids and trailing slash", () => {
            const candidate = `${ORIGIN}${PREFIX}/https/example.com/path#id/`;
            const result = utils().inferTargetUrl(candidate);
            expect(result?.toString()).toBe("https://example.com/path#id/");
        });
    });

    it("returns null for non-proxy URL", () => {
        expect(utils().inferTargetUrl("https://example.com/path")).toBeNull();
    });

    it("returns null for plain relative path", () => {
        expect(utils().inferTargetUrl("/some/path")).toBeNull();
        expect(utils().inferTargetUrl("../some/path")).toBeNull();
        expect(utils().inferTargetUrl("/api/v1")).toBeNull();
    });

    it("returns null for proxy prefix without domain", () => {
        expect(utils().inferTargetUrl("/api/v1/proxy")).toBeNull();
        expect(utils().inferTargetUrl("/api/v1/proxy/")).toBeNull();
    });
});

describe("toTargetUrl", () => {
    it("passes through fragment unchanged", () => {
        expect(utils().toTargetUrl("#section")).toBe("#section");
    });

    it("passes through special protocol unchanged", () => {
        expect(utils().toTargetUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    });

    it("unwraps proxy URL to target", () => {
        const proxied = `${PREFIX}/https/example.com/page`;
        expect(utils().toTargetUrl(proxied)).toBe("https://example.com/page");
    });

    it("resolves relative URL against base", () => {
        const result = utils().toTargetUrl(
            "/about",
            "https://example.com/home",
        );
        expect(result).toBe("https://example.com/about");
    });

    it("returns absolute URL as-is", () => {
        expect(utils().toTargetUrl("https://other.com/path")).toBe(
            "https://other.com/path",
        );
    });

    it("returns null for falsy input", () => {
        expect(utils().toTargetUrl("")).toBeNull();
    });
});

describe("toProxyUrl", () => {
    it("wraps https URL", () => {
        const result = utils().toProxyUrl("https://example.com/path?q=1");
        expect(result).toBe(`${PREFIX}/https/example.com/path?q=1`);
    });

    it("wraps http URL", () => {
        const result = utils().toProxyUrl("http://example.com");
        expect(result).toBe(`${PREFIX}/http/example.com`);
    });

    it("passes through fragment", () => {
        expect(utils().toProxyUrl("#hash")).toBe("#hash");
    });

    it("passes through special protocol", () => {
        expect(utils().toProxyUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    });

    it("omits trailing slash for root path", () => {
        const result = utils().toProxyUrl("https://example.com/");
        expect(result).toBe(`${PREFIX}/https/example.com`);
    });

    it("round-trips: proxy URL → toTargetUrl → toProxyUrl", () => {
        const original = `${PREFIX}/https/example.com/path?q=1`;
        const { toTargetUrl, toProxyUrl } = utils();
        const normalized = toTargetUrl(original);
        expect(toProxyUrl(normalized!)).toBe(original);
    });
});
