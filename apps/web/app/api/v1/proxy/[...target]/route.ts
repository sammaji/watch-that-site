import { getUrl } from "@watchthatsite/ui/lib/utils";
import { NextResponse } from "next/server";

type RouteContext = {
    params: Promise<{
        target: string[];
    }>;
};

export function copyRequestHeaders(source: Headers) {
    const apiKey = process.env.PROXY_API_KEY;
    if (!apiKey) {
        throw new Error("PROXY_API_KEY must be set");
    }
    const headers = new Headers(source);
    headers.set("x-api-key", apiKey);
    return headers;
}

export function copyResponseHeaders(source: Headers) {
    const headers = new Headers(source);
    const strippedResponseHeaders = [
        "connection",
        "content-length",
        "content-security-policy",
        "content-security-policy-report-only",
        "keep-alive",
        "proxy-connection",
        "set-cookie",
        "transfer-encoding",
        "x-frame-options",
    ];
    strippedResponseHeaders.forEach(name => headers.delete(name));
    return headers;
}

async function handle(request: Request, context: RouteContext) {
    const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL;
    if (!proxyUrl) {
        throw new Error("NEXT_PUBLIC_PROXY_URL must be set");
    }
    const { target } = await context.params;
    const search = new URL(request.url).search;
    const targetUrl =
        getUrl(proxyUrl, "api", "v1", "proxy", ...target) + search;

    const method = request.method.toUpperCase();
    const body =
        method === "GET" || method === "HEAD" ?
            undefined
        :   Buffer.from(await request.arrayBuffer());

    let response: Response;
    try {
        response = await fetch(targetUrl, {
            method,
            headers: copyRequestHeaders(request.headers),
            body,
            redirect: "manual",
        });
    } catch (error) {
        // surface upstream-connect failures as 502 instead of a noisy 500 stack.
        return NextResponse.json(
            {
                error:
                    error instanceof Error ?
                        `proxy upstream unavailable: ${error.message}`
                    :   "proxy upstream unavailable",
            },
            { status: 502 },
        );
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: copyResponseHeaders(response.headers),
    });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
