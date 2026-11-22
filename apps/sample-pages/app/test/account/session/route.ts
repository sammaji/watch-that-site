import { ACCOUNT_COOKIE, ACCOUNT_PASSWORD } from "@/lib/account";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Signs the fixture account in: any email, one fixed password. */
export async function POST(request: NextRequest) {
    const form = await request.formData();
    const ok =
        typeof form.get("email") === "string" &&
        form.get("password") === ACCOUNT_PASSWORD;
    const target = new URL(
        ok ? "/test/account" : "/test/account/login?error=1",
        request.url,
    );
    const response = NextResponse.redirect(target, 303);
    if (ok) {
        response.cookies.set(ACCOUNT_COOKIE, "1", {
            httpOnly: true,
            path: "/test/account",
            maxAge: 60 * 60,
        });
    }
    return response;
}

/** Signs out, so a test can expire the saved session. */
export async function DELETE(request: NextRequest) {
    const response = NextResponse.redirect(
        new URL("/test/account/login", request.url),
        303,
    );
    response.cookies.delete({ name: ACCOUNT_COOKIE, path: "/test/account" });
    return response;
}
