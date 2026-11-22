import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
    blocksKey,
    captureShotKey,
    changeCropKey,
    changeDiffKey,
    changeRecordKey,
    learnShotKey,
    stepShotKey,
    storageStateKey,
} from "../src/shared/keys.js";
import { signObjectUrl } from "../src/shared/signing.js";

const TOKEN = "test-token";
const SIGNING_SECRET = "test-signing-secret";
const ORIGIN = "https://worker.test";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6]);

const uuid = () => crypto.randomUUID();

function shotKey(): string {
    return captureShotKey(uuid(), uuid(), "png");
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
    return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

function bearer(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${TOKEN}`, ...extra };
}

function put(
    key: string,
    body: BodyInit = PNG,
    headers: Record<string, string> = {},
): Promise<Response> {
    return call(`/objects/${key}`, {
        method: "PUT",
        headers: bearer({ "content-type": "image/png", ...headers }),
        body,
    });
}

/** A signed path+query for `key`, `ttl` seconds from now (negative = expired). */
async function signedPath(key: string, ttl = 60): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const url = await signObjectUrl(ORIGIN, SIGNING_SECRET, key, exp);
    return url.slice(ORIGIN.length);
}

describe("routing", () => {
    it("reports health", async () => {
        const response = await call("/health");
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it("404s an unknown route", async () => {
        expect((await call("/nope")).status).toBe(404);
    });

    it("405s an unsupported method with an Allow header", async () => {
        const response = await call(`/objects/${shotKey()}`, {
            method: "POST",
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toContain("PUT");
    });
});

describe("write auth", () => {
    it("rejects a write with no token", async () => {
        const response = await call(`/objects/${shotKey()}`, {
            method: "PUT",
            headers: { "content-type": "image/png" },
            body: PNG,
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("rejects a write with the wrong token", async () => {
        const response = await put(shotKey(), PNG, {
            authorization: "Bearer nope",
        });
        expect(response.status).toBe(401);
    });

    it("rejects a write authorised only by a signature", async () => {
        const key = shotKey();
        const response = await call(await signedPath(key), {
            method: "PUT",
            headers: { "content-type": "image/png" },
            body: PNG,
        });
        expect(response.status).toBe(401);
    });

    it("rejects a delete with no token", async () => {
        const response = await call(`/objects/${shotKey()}`, {
            method: "DELETE",
        });
        expect(response.status).toBe(401);
    });

    it("rejects listing with no token", async () => {
        expect((await call("/objects?prefix=captures/")).status).toBe(401);
    });
});

describe("keys", () => {
    it("accepts every key in the layout with its content type", async () => {
        const m = uuid();
        const r = uuid();
        const c = uuid();
        const cases: [string, string][] = [
            [captureShotKey(m, r, "png"), "image/png"],
            [captureShotKey(m, r, "webp"), "image/webp"],
            [learnShotKey(m, r, 0, "png"), "image/png"],
            [learnShotKey(m, r, 2, "webp"), "image/webp"],
            [blocksKey(m, r), "application/gzip"],
            [changeRecordKey(m, c), "application/gzip"],
            [changeDiffKey(m, c), "image/png"],
            [changeCropKey(m, c), "image/png"],
            [storageStateKey(m), "application/json"],
            [stepShotKey(m, r, 0), "image/webp"],
            [stepShotKey(m, r, 12), "image/webp"],
        ];
        for (const [key, contentType] of cases) {
            const response = await put(key, PNG, {
                "content-type": contentType,
            });
            expect(response.status, key).toBe(201);
            const body = await response.json<{
                key: string;
                url: string;
                content_type: string;
            }>();
            expect(body.key).toBe(key);
            expect(body.content_type).toBe(contentType);
            expect(body.url).toBe("");
        }
    });

    it("rejects the old layout and anything outside the new one", async () => {
        const m = uuid();
        const r = uuid();
        for (const key of [
            `screenshots/${m}/${r}.png`,
            `diffs/${m}/${r}.png`,
            `captures/${m}/${r}/shot.jpg`,
            `captures/${m}/${r}/learn-3.png`,
            `captures/${m}/${r}.png`,
            `captures/${m.toUpperCase()}/${r}/shot.png`,
            `captures/not-a-uuid/${r}/shot.png`,
            `changes/${m}/${r}-other.png`,
            `changes/${m}/${r}.json`,
            `state/${m}.json.gz`,
            `state/${m}/${r}.json`,
            `uploads/${m}/${r}.png`,
            `steps/${m}/${r}/07.webp`,
            `steps/${m}/${r}/7.png`,
            `steps/${m}/7.webp`,
            `captures/${m}/${r}/shot.png/extra`,
        ]) {
            const response = await put(key);
            expect(response.status, key).toBe(400);
            await expect(response.json()).resolves.toMatchObject({
                error: { code: "invalid_key" },
            });
        }
    });
});

describe("put", () => {
    it("rejects a content type outside the allow-list", async () => {
        const response = await put(shotKey(), PNG, {
            "content-type": "application/pdf",
        });
        expect(response.status).toBe(415);
    });

    it("rejects an allowed content type that does not match the key", async () => {
        for (const [key, type] of [
            [shotKey(), "image/webp"],
            [storageStateKey(uuid()), "application/gzip"],
            [changeRecordKey(uuid(), uuid()), "application/json"],
            [stepShotKey(uuid(), uuid(), 3), "image/png"],
        ] as const) {
            const response = await put(key, PNG, { "content-type": type });
            expect(response.status, key).toBe(415);
        }
    });

    it("rejects an empty body", async () => {
        const response = await put(shotKey(), new Uint8Array());
        expect(response.status).toBe(400);
    });

    it("overwrites an existing object", async () => {
        const key = shotKey();
        await put(key);
        const replacement = new Uint8Array([9, 9, 9]);
        expect((await put(key, replacement)).status).toBe(201);

        const stored = await call(`/objects/${key}`, { headers: bearer() });
        expect(new Uint8Array(await stored.arrayBuffer())).toEqual(replacement);
    });
});

describe("read auth", () => {
    it("401s an unsigned, unauthenticated GET", async () => {
        const key = shotKey();
        await put(key);
        const response = await call(`/objects/${key}`);
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
            error: { code: "unauthorized" },
        });
    });

    it("401s an unsigned, unauthenticated HEAD", async () => {
        const key = shotKey();
        await put(key);
        expect((await call(`/objects/${key}`, { method: "HEAD" })).status).toBe(
            401,
        );
    });

    it("serves a signed GET with a private, bounded cache header", async () => {
        const key = shotKey();
        await put(key);

        const response = await call(await signedPath(key, 60));
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
        const cache = response.headers.get("Cache-Control") ?? "";
        expect(cache).toMatch(/^private, max-age=(\d+)$/);
        expect(Number(/max-age=(\d+)/.exec(cache)?.[1])).toBeLessThanOrEqual(
            60,
        );
        expect(cache).not.toContain("immutable");
    });

    it("caps the signed cache lifetime at 300 seconds", async () => {
        const key = shotKey();
        await put(key);
        const response = await call(await signedPath(key, 7 * 24 * 3600));
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe(
            "private, max-age=300",
        );
    });

    it("serves a signed HEAD", async () => {
        const key = shotKey();
        await put(key);
        const response = await call(await signedPath(key), { method: "HEAD" });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe(
            String(PNG.byteLength),
        );
    });

    it("401s an expired signature", async () => {
        const key = shotKey();
        await put(key);
        const response = await call(await signedPath(key, -1));
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
            error: { code: "expired_signature" },
        });
    });

    it("401s a tampered signature", async () => {
        const key = shotKey();
        await put(key);
        const path = await signedPath(key);
        const sig = /sig=([0-9a-f]+)/.exec(path)?.[1] ?? "";
        const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
        const response = await call(path.replace(sig, flipped));
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
            error: { code: "invalid_signature" },
        });
    });

    it("401s a signature moved to another key or a changed exp", async () => {
        const key = shotKey();
        const other = shotKey();
        await put(key);
        await put(other);
        const path = await signedPath(key);
        expect((await call(path.replace(key, other))).status).toBe(401);

        const exp = Number(/exp=(\d+)/.exec(path)?.[1]);
        expect(
            (await call(path.replace(`exp=${exp}`, `exp=${exp + 1000}`)))
                .status,
        ).toBe(401);
    });

    it("401s a malformed signature query", async () => {
        const key = shotKey();
        for (const query of [
            "?sig=abc",
            "?exp=123",
            "?exp=abc&sig=00",
            `?exp=9999999999&sig=${"g".repeat(64)}`,
        ]) {
            expect((await call(`/objects/${key}${query}`)).status, query).toBe(
                401,
            );
        }
    });

    it("serves a bearer GET with no-store", async () => {
        const key = shotKey();
        await put(key);
        const response = await call(`/objects/${key}`, { headers: bearer() });
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(response.headers.get("Content-Length")).toBe(
            String(PNG.byteLength),
        );
        expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    });

    it("judges a request with a wrong bearer token on the token alone", async () => {
        const key = shotKey();
        await put(key);
        const response = await call(await signedPath(key), {
            headers: { authorization: "Bearer nope" },
        });
        expect(response.status).toBe(401);
    });
});

describe("get", () => {
    it("round-trips gzip and json objects", async () => {
        const m = uuid();
        const gz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
        const key = changeRecordKey(m, uuid());
        await put(key, gz, { "content-type": "application/gzip" });

        const response = await call(await signedPath(key));
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("application/gzip");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(gz);
    });

    it("404s a missing object", async () => {
        const response = await call(`/objects/${shotKey()}`, {
            headers: bearer(),
        });
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
            error: { code: "not_found" },
        });
    });

    it("serves a byte range", async () => {
        const key = shotKey();
        await put(key);

        const response = await call(`/objects/${key}`, {
            headers: bearer({ range: "bytes=0-3" }),
        });
        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe(
            `bytes 0-3/${PNG.byteLength}`,
        );
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            PNG.slice(0, 4),
        );
    });

    it("304s a matching If-None-Match", async () => {
        const key = shotKey();
        await put(key);

        const first = await call(`/objects/${key}`, { headers: bearer() });
        const etag = first.headers.get("ETag");
        expect(etag).toBeTruthy();

        const second = await call(`/objects/${key}`, {
            headers: bearer({ "if-none-match": etag as string }),
        });
        expect(second.status).toBe(304);
    });
});

describe("head", () => {
    it("returns metadata without a body", async () => {
        const key = shotKey();
        await put(key);

        const response = await call(`/objects/${key}`, {
            method: "HEAD",
            headers: bearer(),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe(
            String(PNG.byteLength),
        );
        expect(response.headers.get("Content-Type")).toBe("image/png");
    });

    it("404s a missing object", async () => {
        const response = await call(`/objects/${shotKey()}`, {
            method: "HEAD",
            headers: bearer(),
        });
        expect(response.status).toBe(404);
    });
});

describe("delete", () => {
    it("removes the object and stays idempotent", async () => {
        const key = shotKey();
        await put(key);

        const first = await call(`/objects/${key}`, {
            method: "DELETE",
            headers: bearer(),
        });
        expect(first.status).toBe(204);
        expect(
            (await call(`/objects/${key}`, { headers: bearer() })).status,
        ).toBe(404);

        const again = await call(`/objects/${key}`, {
            method: "DELETE",
            headers: bearer(),
        });
        expect(again.status).toBe(204);
    });
});

describe("list", () => {
    it("lists objects under a monitor prefix", async () => {
        const monitorId = uuid();
        const keys = [
            captureShotKey(monitorId, uuid(), "png"),
            captureShotKey(monitorId, uuid(), "png"),
        ];
        for (const key of keys) {
            await put(key);
        }

        const response = await call(`/objects?prefix=captures/${monitorId}/`, {
            headers: bearer(),
        });
        expect(response.status).toBe(200);

        const body = await response.json<{
            objects: {
                key: string;
                url: string;
                content_type: string | null;
            }[];
            truncated: boolean;
            cursor: string | null;
        }>();
        expect(body.objects.map(object => object.key).sort()).toEqual(
            [...keys].sort(),
        );
        expect(body.objects[0]?.url).toBe("");
        expect(body.objects[0]?.content_type).toBe("image/png");
        expect(body.truncated).toBe(false);
        expect(body.cursor).toBeNull();
    });

    it("accepts each new prefix and rejects the old ones", async () => {
        for (const prefix of ["captures/", "changes/", "state/", "state"]) {
            const response = await call(`/objects?prefix=${prefix}`, {
                headers: bearer(),
            });
            expect(response.status, prefix).toBe(200);
        }
        for (const prefix of ["screenshots/", "diffs/", "../etc", "cap"]) {
            const response = await call(`/objects?prefix=${prefix}`, {
                headers: bearer(),
            });
            expect(response.status, prefix).toBe(400);
        }
    });

    it("requires a prefix", async () => {
        const response = await call("/objects", { headers: bearer() });
        expect(response.status).toBe(400);
    });

    it("rejects an out-of-range limit", async () => {
        const response = await call("/objects?prefix=changes/&limit=5000", {
            headers: bearer(),
        });
        expect(response.status).toBe(400);
    });
});
