/**
 * Test users for suites that talk to the running web app and PostgREST.
 *
 * Sign-up requires email verification (packages/auth/src/server.ts), so a test
 * user is created through the Better Auth sign-up API, marked verified
 * directly in Postgres, then signed in for a session cookie. The PostgREST JWT
 * comes from the Better Auth JWT plugin (`GET /api/auth/token`), exactly as
 * the web app's `getPostgrestToken` obtains it.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import "./load-env";
import { getDatabaseUrl } from "./utils";

export type TestUser = {
    id: string;
    label: string;
    name: string;
    email: string;
    password: string;
    /** Cookie header value carrying the Better Auth session. */
    cookie: string;
    /** PostgREST JWT (`role: authenticated`). Refreshed by `userJwt`. */
    jwt: string;
    jwtIssuedAt: number;
};

// Better Auth issues the JWT with a 1 h expiry; refresh well before that.
const JWT_REFRESH_AFTER_MS = 45 * 60 * 1000;

export function webUrl() {
    return (
        process.env.TEST_WEB_URL ??
        process.env.BETTER_AUTH_URL ??
        process.env.NEXT_PUBLIC_APP_URL ??
        "http://localhost:3000"
    ).replace(/\/+$/, "");
}

function appOrigin() {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || webUrl()).origin;
}

let pool: pg.Pool | null = null;

/** db returns a shared pg pool for the local database (superuser/owner). */
export function db() {
    if (!pool) {
        pool = new pg.Pool({ connectionString: getDatabaseUrl(), max: 4 });
    }
    return pool;
}

export async function closeDb() {
    const current = pool;
    pool = null;
    if (current) await current.end();
}

async function authFetch(
    path: string,
    init: RequestInit & { cookie?: string } = {},
) {
    const headers = new Headers(init.headers);
    headers.set("origin", appOrigin());
    if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
    }
    if (init.cookie) headers.set("cookie", init.cookie);
    return fetch(`${webUrl()}/api/auth${path}`, {
        ...init,
        headers,
        redirect: "manual",
    });
}

async function failure(res: Response, what: string) {
    const body = await res.text().catch(() => "");
    return new Error(
        `${what} failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
}

/** cookieHeader turns Set-Cookie headers into a Cookie request header. */
function cookieHeader(res: Response) {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    return setCookies
        .map(c => c.split(";")[0]!.trim())
        .filter(pair => pair.includes("=") && !pair.endsWith("="))
        .join("; ");
}

async function signIn(email: string, password: string) {
    const res = await authFetch("/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email, password, rememberMe: true }),
    });
    if (!res.ok) throw await failure(res, `sign in ${email}`);
    const cookie = cookieHeader(res);
    if (!cookie) throw new Error(`sign in ${email} returned no session cookie`);
    return cookie;
}

/** fetchJwt returns a PostgREST JWT for the session cookie. */
export async function fetchJwt(cookie: string) {
    const res = await authFetch("/token", { method: "GET", cookie });
    if (res.ok) {
        const payload = (await res.json()) as { token?: string };
        if (payload.token) return payload.token;
    }
    // Fallback used by the web app too: get-session sets `set-auth-jwt`.
    const session = await authFetch("/get-session", { method: "GET", cookie });
    const header = session.headers.get("set-auth-jwt");
    if (header) return header;
    throw await failure(res, "fetch PostgREST JWT");
}

/**
 * createTestUser signs up a fresh, verified user and
 * returns its session cookie and PostgREST JWT.
 */
export async function createTestUser(label: string): Promise<TestUser> {
    const suffix = randomUUID().slice(0, 8);
    const safeLabel = label.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    // Sign-up sends a verification email through Resend; resend.dev's
    // "delivered+" addresses are Resend's own test inboxes.
    const email = `delivered+wts-e2e-${safeLabel}-${suffix}@resend.dev`;
    const password = `E2e-${randomUUID()}`;
    const name = `E2E ${label}`;

    const signUp = await authFetch("/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
    });
    if (!signUp.ok) throw await failure(signUp, `sign up ${email}`);

    const verified = await db().query<{ id: string }>(
        "UPDATE users SET email_verified = true WHERE email = $1 RETURNING id",
        [email],
    );
    const id = verified.rows[0]?.id;
    if (!id) throw new Error(`sign up ${email} did not create a users row`);

    const cookie = await signIn(email, password);
    const jwt = await fetchJwt(cookie);
    return {
        id,
        label,
        name,
        email,
        password,
        cookie,
        jwt,
        jwtIssuedAt: Date.now(),
    };
}

/** userJwt returns a PostgREST JWT for the user, refreshing it when old. */
export async function userJwt(user: TestUser) {
    if (Date.now() - user.jwtIssuedAt > JWT_REFRESH_AFTER_MS) {
        user.jwt = await fetchJwt(user.cookie);
        user.jwtIssuedAt = Date.now();
    }
    return user.jwt;
}

/**
 * deleteTestUser deletes the account the way its owner would (Better Auth's
 * delete-user endpoint), which also removes its virtual key and provider keys
 * from the model gateway; Postgres rows go with the users row by ON DELETE
 * CASCADE. A user without a session is removed from Postgres directly.
 */
export async function deleteTestUser(
    user: (Pick<TestUser, "id"> & Partial<TestUser>) | null | undefined,
) {
    if (!user) return;
    if (user.cookie && user.password) {
        const res = await authFetch("/delete-user", {
            method: "POST",
            cookie: user.cookie,
            body: JSON.stringify({ password: user.password }),
        });
        if (!res.ok) throw await failure(res, "delete-user");
    }
    await db().query("DELETE FROM users WHERE id = $1", [user.id]);
}
