import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
    return respond(request, null);
}

export async function POST(request: NextRequest) {
    const text = await request.text();
    return respond(request, text || null);
}

function respond(request: NextRequest, body: string | null) {
    const referer = request.headers.get("referer");

    return NextResponse.json({
        method: request.method,
        path: request.nextUrl.pathname,
        search: request.nextUrl.search,
        proxied: referer === request.url ? "through-proxy" : "direct",
        body,
    });
}
