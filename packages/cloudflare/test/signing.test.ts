import { describe, expect, it } from "vitest";
import {
    objectSignature,
    signObjectUrl,
    signObjectUrlFor,
} from "../src/shared/signing.js";

/**
 * Cross-language test vector. The same key, secret, exp and expected
 * signature appear in packages/cloudflare_go/r2/sign_test.go; if either side
 * changes the algorithm, both tests fail.
 */
const VECTOR = {
    key: "changes/8dea949d-d40b-49f6-8f9a-9e31f891eb4e/2136440b-8e77-4a2d-8fe2-fcaea8af11f7.json.gz",
    secret: "wts-test-vector-secret",
    exp: 1790000000,
    sig: "8930f280ad5550761f7abe127901c6c59d04d4c7004add5819cc21d987e14592",
};

describe("objectSignature", () => {
    it("matches the shared test vector", async () => {
        await expect(
            objectSignature(VECTOR.secret, VECTOR.key, VECTOR.exp),
        ).resolves.toBe(VECTOR.sig);
    });

    it("rejects an empty secret and a bad exp", async () => {
        await expect(
            objectSignature("", VECTOR.key, VECTOR.exp),
        ).rejects.toThrow(TypeError);
        await expect(objectSignature("s", VECTOR.key, 1.5)).rejects.toThrow(
            TypeError,
        );
    });
});

describe("signObjectUrl", () => {
    it("builds {base}/objects/{key}?exp=&sig=", async () => {
        await expect(
            signObjectUrl(
                "https://objects.example///",
                VECTOR.secret,
                VECTOR.key,
                VECTOR.exp,
            ),
        ).resolves.toBe(
            `https://objects.example/objects/${VECTOR.key}?exp=${VECTOR.exp}&sig=${VECTOR.sig}`,
        );
    });

    it("computes exp from a ttl", async () => {
        const now = new Date((VECTOR.exp - 300) * 1000);
        await expect(
            signObjectUrlFor("http://w", VECTOR.secret, VECTOR.key, 300, now),
        ).resolves.toContain(`exp=${VECTOR.exp}&sig=${VECTOR.sig}`);
    });
});
