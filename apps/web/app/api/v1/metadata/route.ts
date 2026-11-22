import type { PageMetadata } from "@/lib/api";
import { NextResponse } from "next/server";

const MAX_METADATA_CHARS = 512 * 1024;

function decodeHtml(value: string) {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .trim();
}

function stripTags(value: string) {
    return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function parseAttributes(tag: string) {
    const attributes: Record<string, string> = {};
    const matches = tag.matchAll(
        /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    );

    for (const match of matches) {
        const name = match[1]?.toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? "";
        if (name && name !== "meta" && name !== "link") {
            attributes[name] = decodeHtml(value);
        }
    }

    return attributes;
}

function findTitle(html: string) {
    return stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function findFirstH1(html: string) {
    return stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
}

function resolveUrl(value: string, baseUrl: URL) {
    if (!value) return "";

    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return value;
    }
}

function extractMetadata(html: string, baseUrl: URL): PageMetadata {
    let ogTitle = "";
    let twitterTitle = "";
    let ogDescription = "";
    let twitterDescription = "";
    let metaDescription = "";
    let ogImage = "";
    let twitterImage = "";
    let favicon = "";

    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = parseAttributes(match[0]);
        const property = attrs.property?.toLowerCase();
        const name = attrs.name?.toLowerCase();
        const content = attrs.content?.trim();

        if (!content) continue;

        switch (true) {
            case property === "og:title":
                ogTitle = content;
                break;
            case property === "og:description":
                ogDescription = content;
                break;
            case property === "og:image":
                ogImage = content;
                break;
            case name === "twitter:title":
                twitterTitle = content;
                break;
            case name === "twitter:description":
                twitterDescription = content;
                break;
            case name === "twitter:image":
                twitterImage = content;
                break;
            case name === "description":
                metaDescription = content;
                break;
        }
    }

    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
        const attrs = parseAttributes(match[0]);
        if (
            !favicon &&
            attrs.rel?.toLowerCase().includes("icon") &&
            attrs.href
        ) {
            favicon = resolveUrl(attrs.href, baseUrl);
        }
    }

    return {
        url: baseUrl.toString(),
        title:
            ogTitle ||
            twitterTitle ||
            findTitle(html) ||
            findFirstH1(html) ||
            undefined,
        description:
            ogDescription || twitterDescription || metaDescription || undefined,
        image: resolveUrl(ogImage || twitterImage, baseUrl) || undefined,
        favicon: favicon || undefined,
    };
}

export async function GET(request: Request) {
    const rawUrl = new URL(request.url).searchParams.get("url")?.trim();
    if (!rawUrl) {
        return NextResponse.json(
            { error: "url query param is required" },
            { status: 400 },
        );
    }

    let targetUrl: URL;
    try {
        targetUrl = new URL(rawUrl);
    } catch {
        return NextResponse.json({ error: "invalid url" }, { status: 400 });
    }

    if (!/^https?:$/.test(targetUrl.protocol)) {
        return NextResponse.json({ error: "invalid url" }, { status: 400 });
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                // one UA string is enough for sites that gate empty/default clients.
                "user-agent":
                    "watchthatsite-metadata/0.1 (+https://wts.sammaji.com)",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
            return NextResponse.json(
                { error: `target returned status ${response.status}` },
                { status: 502 },
            );
        }

        // read text directly; metadata lives near the top of normal HTML pages.
        const html = (await response.text()).slice(0, MAX_METADATA_CHARS);
        return NextResponse.json(extractMetadata(html, targetUrl));
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error ?
                        error.message
                    :   "metadata fetch failed",
            },
            { status: 502 },
        );
    }
}
