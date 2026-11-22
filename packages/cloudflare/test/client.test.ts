import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
    captureShotKey,
    changeRecordKey,
    createObjectStoreClient,
    ObjectStoreError,
    storageStateKey,
    type FetchLike,
} from "../src/client/index.js";

const TOKEN = "test-token";
const SIGNING_SECRET = "test-signing-secret";
const BASE_URL = "https://worker.test";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

/**
 * Routes the client straight at the Worker's own handler, so these run against
 * the real routing, auth, and local R2 rather than a hand-written double.
 */
const workerFetch: FetchLike = (input, init) =>
    exports.default.fetch(new Request(input, init as RequestInit));

function client(
    overrides: Partial<Parameters<typeof createObjectStoreClient>[0]> = {},
) {
    return createObjectStoreClient({
        baseUrl: BASE_URL,
        token: TOKEN,
        signingSecret: SIGNING_SECRET,
        fetch: workerFetch,
        retries: 0,
        ...overrides,
    });
}

function ids() {
    return { monitorId: crypto.randomUUID(), runId: crypto.randomUUID() };
}

describe("construction", () => {
    it("requires a base url and a token", () => {
        expect(() =>
            createObjectStoreClient({ baseUrl: "", token: TOKEN }),
        ).toThrow(TypeError);
        expect(() =>
            createObjectStoreClient({ baseUrl: BASE_URL, token: "" }),
        ).toThrow(TypeError);
    });

    it("normalises trailing slashes on the base url", () => {
        expect(client({ baseUrl: `${BASE_URL}///` }).baseUrl).toBe(BASE_URL);
    });
});

describe("uploads", () => {
    it("stores a capture shot under captures/{m}/{r}/shot.{format}", async () => {
        const { monitorId, runId } = ids();
        const object = await client().uploadCaptureShot(
            monitorId,
            runId,
            PNG,
            "webp",
        );

        expect(object.key).toBe(`captures/${monitorId}/${runId}/shot.webp`);
        expect(object.size).toBe(PNG.byteLength);
        expect(object.content_type).toBe("image/webp");
        expect(object.url).toBe("");
        expect(object.etag).toBeTruthy();
    });

    it("stores a learning shot", async () => {
        const { monitorId, runId } = ids();
        const object = await client().uploadLearnShot(
            monitorId,
            runId,
            1,
            PNG,
            "png",
        );
        expect(object.key).toBe(`captures/${monitorId}/${runId}/learn-1.png`);
    });

    it("derives the content type from the key", async () => {
        const { monitorId, runId } = ids();
        const object = await client().putObject(
            changeRecordKey(monitorId, runId),
            new Uint8Array([0x1f, 0x8b, 8, 0]),
        );
        expect(object.content_type).toBe("application/gzip");
    });

    it("rejects an invalid key before making a request", async () => {
        const transport = vi.fn(workerFetch);
        const store = client({ fetch: transport });

        await expect(
            store.putObject("screenshots/whatever.png", PNG),
        ).rejects.toMatchObject({ code: "invalid_key" });
        expect(transport).not.toHaveBeenCalled();
    });

    it("rejects an empty body before making a request", async () => {
        const { monitorId, runId } = ids();
        const transport = vi.fn(workerFetch);
        const store = client({ fetch: transport });

        await expect(
            store.uploadCaptureShot(monitorId, runId, new Uint8Array(), "png"),
        ).rejects.toMatchObject({ code: "empty_body" });
        expect(transport).not.toHaveBeenCalled();
    });

    it("surfaces the worker's error code on a rejected upload", async () => {
        const { monitorId, runId } = ids();
        const error = await client()
            .putObject(captureShotKey(monitorId, runId, "png"), PNG, {
                contentType: "application/pdf",
            })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ObjectStoreError);
        expect(error).toMatchObject({
            status: 415,
            code: "unsupported_media_type",
        });
    });

    it("fails with unauthorized when the token is wrong", async () => {
        const { monitorId, runId } = ids();
        await expect(
            client({ token: "nope" }).uploadCaptureShot(
                monitorId,
                runId,
                PNG,
                "png",
            ),
        ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    });
});

describe("reads", () => {
    it("gets bytes back with the bearer token, null when missing", async () => {
        const { monitorId, runId } = ids();
        const store = client();
        const key = captureShotKey(monitorId, runId, "png");

        expect(await store.getObject(key)).toBeNull();
        await store.putObject(key, PNG, { contentType: "image/png" });
        expect(await store.getObject(key)).toEqual(PNG);
    });

    it("round-trips storage state", async () => {
        const { monitorId } = ids();
        const store = client();
        expect(await store.getStorageState(monitorId)).toBeNull();

        const state = { cookies: [{ name: "sid", value: "1" }], origins: [] };
        const stored = await store.putStorageState(monitorId, state);
        expect(stored.key).toBe(storageStateKey(monitorId));
        expect(stored.content_type).toBe("application/json");
        expect(await store.getStorageState(monitorId)).toEqual(state);
    });

    it("mints a signed url the Worker accepts without a token", async () => {
        const { monitorId, runId } = ids();
        const store = client();
        const key = captureShotKey(monitorId, runId, "png");
        await store.putObject(key, PNG);

        const url = await store.signedUrl(key, 60);
        expect(url).toMatch(
            new RegExp(
                `^${BASE_URL}/objects/${key}\\?exp=\\d+&sig=[0-9a-f]{64}$`,
            ),
        );
        const response = await exports.default.fetch(new Request(url));
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    });

    it("refuses to sign without a signing secret", async () => {
        const { monitorId, runId } = ids();
        const store = client({ signingSecret: "" });
        expect(() =>
            store.signedUrl(captureShotKey(monitorId, runId, "png"), 60),
        ).toThrow(ObjectStoreError);
    });
});

describe("head, delete and list", () => {
    it("reads back metadata and returns null for a missing object", async () => {
        const { monitorId, runId } = ids();
        const store = client();
        const key = captureShotKey(monitorId, runId, "png");

        expect(await store.headObject(key)).toBeNull();

        await store.putObject(key, PNG);
        const head = await store.headObject(key);

        expect(head).not.toBeNull();
        expect(head?.size).toBe(PNG.byteLength);
        expect(head?.content_type).toBe("image/png");
    });

    it("deletes idempotently", async () => {
        const { monitorId, runId } = ids();
        const store = client();
        const key = captureShotKey(monitorId, runId, "png");

        await store.putObject(key, PNG);
        await store.deleteObject(key);
        expect(await store.headObject(key)).toBeNull();

        await expect(store.deleteObject(key)).resolves.toBeUndefined();
    });

    it("lists a monitor's captures", async () => {
        const monitorId = crypto.randomUUID();
        const store = client();
        const keys = [
            captureShotKey(monitorId, crypto.randomUUID(), "png"),
            captureShotKey(monitorId, crypto.randomUUID(), "png"),
        ];
        for (const key of keys) {
            await store.putObject(key, PNG);
        }

        const listing = await store.listObjects(`captures/${monitorId}/`);

        expect(listing.objects.map(o => o.key).sort()).toEqual(
            [...keys].sort(),
        );
        expect(listing.truncated).toBe(false);
        expect(listing.cursor).toBeNull();
    });

    it("stores and lists a Run's step screenshots", async () => {
        const monitorId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const store = client();
        const keys = [0, 1, 10].map(
            seq => `steps/${monitorId}/${runId}/${seq}.webp`,
        );
        for (const key of keys) {
            // The client derives image/webp from the key.
            const object = await store.putObject(key, PNG);
            expect(object.key).toBe(key);
        }
        const listing = await store.listObjects(`steps/${monitorId}/${runId}/`);
        expect(listing.objects.map(o => o.key).sort()).toEqual(
            [...keys].sort(),
        );
        expect(await store.getObject(keys[2]!)).not.toBeNull();
        // A padded number is a different, invalid key: refused before any request.
        await expect(
            store.putObject(`steps/${monitorId}/${runId}/01.webp`, PNG),
        ).rejects.toMatchObject({ code: "invalid_key" });
    });

    it("rejects a prefix outside the known kinds", async () => {
        await expect(client().listObjects("../etc")).rejects.toMatchObject({
            status: 400,
            code: "invalid_prefix",
        });
    });
});

describe("transport failures", () => {
    it("retries a network error and then succeeds", async () => {
        const { monitorId, runId } = ids();
        let calls = 0;
        const transport: FetchLike = (input, init) => {
            calls++;
            if (calls === 1) {
                return Promise.reject(new Error("ECONNRESET"));
            }
            return workerFetch(input, init);
        };

        const object = await client({
            fetch: transport,
            retries: 1,
        }).uploadCaptureShot(monitorId, runId, PNG, "png");

        expect(calls).toBe(2);
        expect(object.key).toBe(`captures/${monitorId}/${runId}/shot.png`);
    });

    it("gives up after the retry budget with a network_error", async () => {
        const { monitorId, runId } = ids();
        const transport: FetchLike = () =>
            Promise.reject(new Error("ECONNRESET"));

        const error = await client({ fetch: transport, retries: 1 })
            .uploadCaptureShot(monitorId, runId, PNG, "png")
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ObjectStoreError);
        expect(error).toMatchObject({ status: 0, code: "network_error" });
    });

    it("does not retry a 4xx", async () => {
        const { monitorId, runId } = ids();
        let calls = 0;
        const transport: FetchLike = (input, init) => {
            calls++;
            return workerFetch(input, init);
        };

        await client({ fetch: transport, retries: 2, token: "nope" })
            .uploadCaptureShot(monitorId, runId, PNG, "png")
            .catch(() => undefined);

        expect(calls).toBe(1);
    });
});
