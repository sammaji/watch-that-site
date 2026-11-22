import { auth } from "@watchthatsite/auth/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
    const session = await auth.api.getSession({
        headers: request.headers,
    });
    if (!session) {
        // For API routes, return 401
        if (request.nextUrl.pathname.startsWith("/api")) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }
        // For non-API routes, redirect to login
        return NextResponse.redirect(new URL("/login", request.url));
    }
    return NextResponse.next();
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - /api/auth, /api/auth/*
         * - /login, /signup, /forgot-password, /update-password, /verify
         * - /_next/static, /_next/image, /favicon.ico - static assets
         * - /images/*, the icons and the manifest - files in public/ that the
         *   sign-in pages show to people who are not signed in yet
         */
        "/((?!api/auth|login|signup|forgot-password|update-password|verify|_next/static|_next/image|favicon.ico|favicon-|apple-touch-icon|android-chrome-|site.webmanifest|images/).*)",
    ],
};
