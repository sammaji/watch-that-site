import {
    canSeeMonitor,
    objectStoreConfig,
    parseObjectKey,
    signObjectUrl,
} from "@/lib/objects";
import { auth } from "@watchthatsite/auth/server";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

/**
 * GET /api/v1/objects/{key}[?inline=1]
 *
 * The only way the browser reads Captures and Change Records. It
 * authenticates the session, checks through PostgREST (as the viewer, so RLS
 * decides) that the Monitor id in the key is visible, and then:
 *
 * - by default, 302-redirects to a signed object-store Worker URL valid for
 *   5 minutes (use this for `<img src>`);
 * - with `?inline=1`, proxies the bytes instead. `.json.gz` objects are
 *   gunzipped and served as `application/json`, so `fetch(...).json()` works.
 *
 * Unknown keys and Monitors the viewer cannot see are both 404, so the route
 * does not reveal which Monitor ids exist.
 */

export const dynamic = "force-dynamic";

type RouteContext = {
    params: Promise<{ key: string[] }>;
};

const NO_STORE = { "Cache-Control": "private, no-store" };

function notFound() {
    return NextResponse.json(
        { error: "not found" },
        { status: 404, headers: NO_STORE },
    );
}

async function postgrestToken(): Promise<string | null> {
    try {
        const result = await auth.api.getToken({ headers: await headers() });
        return result?.token ?? null;
    } catch {
        // No session (or an expired one): getToken throws UNAUTHORIZED.
        return null;
    }
}

export async function GET(request: Request, context: RouteContext) {
    const { key: segments } = await context.params;
    const parsed = parseObjectKey((segments ?? []).join("/"));
    if (!parsed) return notFound();

    const token = await postgrestToken();
    if (!token) {
        return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401, headers: NO_STORE },
        );
    }

    try {
        if (!(await canSeeMonitor(parsed.monitorId, token))) return notFound();
    } catch (error) {
        console.error("[objects] monitor lookup failed", error);
        return NextResponse.json(
            { error: "monitor lookup failed" },
            { status: 502, headers: NO_STORE },
        );
    }

    const config = objectStoreConfig();
    if (!config) {
        console.error(
            "[objects] R2_WORKER_URL and R2_SIGNING_SECRET must be set",
        );
        return NextResponse.json(
            { error: "object store not configured" },
            { status: 500, headers: NO_STORE },
        );
    }

    const signed = await signObjectUrl(
        config.workerUrl,
        config.signingSecret,
        parsed.key,
    );

    if (new URL(request.url).searchParams.get("inline") !== "1") {
        const response = NextResponse.redirect(signed, 302);
        response.headers.set("Cache-Control", "private, no-store");
        return response;
    }

    let upstream: Response;
    try {
        upstream = await fetch(signed, {
            cache: "no-store",
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        console.error("[objects] object store unreachable", error);
        return NextResponse.json(
            { error: "object store unavailable" },
            { status: 502, headers: NO_STORE },
        );
    }
    if (upstream.status === 404) return notFound();
    if (!upstream.ok || !upstream.body) {
        return NextResponse.json(
            { error: `object store responded ${upstream.status}` },
            { status: 502, headers: NO_STORE },
        );
    }

    if (parsed.gzipJson) {
        return new Response(
            upstream.body.pipeThrough(new DecompressionStream("gzip")),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    ...NO_STORE,
                },
            },
        );
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type":
                upstream.headers.get("content-type") ??
                "application/octet-stream",
            ...NO_STORE,
        },
    });
}
