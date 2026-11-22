import { describe, expect, it } from "vitest";
import {
    checkResponse,
    isCrossDomain,
    type ResponseSignals,
} from "./validity.js";

function signals(overrides: Partial<ResponseSignals> = {}): ResponseSignals {
    return {
        status: 200,
        requestedUrl: "https://shop.example.com/pricing",
        finalUrl: "https://shop.example.com/pricing",
        title: "Pricing",
        bodyText: "Pro plan $49",
        html: "<html><body><p>Pro plan $49</p></body></html>",
        headers: {},
        ...overrides,
    };
}

describe("checkResponse", () => {
    it("accepts a normal page", () => {
        expect(checkResponse(signals())).toBeNull();
    });

    it.each([400, 404, 500, 503])("flags HTTP %i", status => {
        expect(checkResponse(signals({ status }))).toBe("http_status");
    });

    it.each([
        ["Cloudflare", { title: "Just a moment..." }],
        ["Cloudflare block", { title: "Attention Required! | Cloudflare" }],
        ["Akamai", { title: "Access Denied" }],
        ["PerimeterX", { bodyText: "Press & Hold to confirm you are a human" }],
        [
            "DataDome",
            { html: '<script src="https://ct.captcha-delivery.com/c.js">' },
        ],
        ["cf-mitigated header", { headers: { "cf-mitigated": "challenge" } }],
        [
            "x-datadome on a 403",
            { status: 403, headers: { "x-datadome": "protected" } },
        ],
    ])("detects a %s challenge", (_name, overrides) => {
        expect(
            checkResponse(signals(overrides as Partial<ResponseSignals>)),
        ).toBe("challenge");
    });

    it("reports a 503 challenge as a challenge, not an HTTP error", () => {
        expect(
            checkResponse(signals({ status: 503, title: "Just a moment..." })),
        ).toBe("challenge");
    });

    it("does not treat x-datadome on a 200 as a challenge", () => {
        expect(
            checkResponse(signals({ headers: { "x-datadome": "protected" } })),
        ).toBeNull();
    });

    it("flags a redirect to another registrable domain", () => {
        expect(
            checkResponse(signals({ finalUrl: "https://login.other.org/" })),
        ).toBe("cross_domain");
    });
});

describe("isCrossDomain", () => {
    it("allows subdomain and path changes on the same registrable domain", () => {
        expect(
            isCrossDomain(
                "https://example.co.uk/a",
                "https://www.example.co.uk/b",
            ),
        ).toBe(false);
    });

    it("compares hostnames for hosts without a public suffix", () => {
        expect(
            isCrossDomain("http://127.0.0.1:3000/", "http://127.0.0.1:3000/x"),
        ).toBe(false);
        expect(
            isCrossDomain("http://127.0.0.1:3000/", "http://localhost:3000/"),
        ).toBe(true);
    });
});
