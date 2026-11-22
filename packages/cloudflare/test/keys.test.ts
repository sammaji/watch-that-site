import { describe, expect, it } from "vitest";
import {
    blocksKey,
    captureShotKey,
    changeCropKey,
    changeDiffKey,
    changeRecordKey,
    isAllowedListPrefix,
    learnShotKey,
    parseObjectKey,
    stepShotKey,
    storageStateKey,
} from "../src/shared/keys.js";

const M = "8dea949d-d40b-49f6-8f9a-9e31f891eb4e";
const R = "2136440b-8e77-4a2d-8fe2-fcaea8af11f7";

describe("key builders", () => {
    it("produce the documented layout", () => {
        expect(captureShotKey(M, R, "webp")).toBe(
            `captures/${M}/${R}/shot.webp`,
        );
        expect(learnShotKey(M, R, 1, "png")).toBe(
            `captures/${M}/${R}/learn-1.png`,
        );
        expect(blocksKey(M, R)).toBe(`captures/${M}/${R}/blocks.json.gz`);
        expect(changeRecordKey(M, R)).toBe(`changes/${M}/${R}.json.gz`);
        expect(changeDiffKey(M, R)).toBe(`changes/${M}/${R}-diff.png`);
        expect(changeCropKey(M, R)).toBe(`changes/${M}/${R}-crop.png`);
        expect(storageStateKey(M)).toBe(`state/${M}.json`);
        expect(stepShotKey(M, R, 0)).toBe(`steps/${M}/${R}/0.webp`);
        expect(stepShotKey(M, R, 17)).toBe(`steps/${M}/${R}/17.webp`);
    });

    it("lower-case ids and reject bad input", () => {
        expect(storageStateKey(M.toUpperCase())).toBe(`state/${M}.json`);
        expect(() => storageStateKey("../x")).toThrow(TypeError);
        expect(() => learnShotKey(M, R, 3)).toThrow(TypeError);
        expect(() => captureShotKey(M, R, "gif" as "png")).toThrow(TypeError);
        expect(stepShotKey(M.toUpperCase(), R, 3)).toBe(
            `steps/${M}/${R}/3.webp`,
        );
        for (const seq of [-1, 1.5, Number.NaN, 1e12]) {
            expect(() => stepShotKey(M, R, seq), String(seq)).toThrow(
                TypeError,
            );
        }
        expect(() => stepShotKey(M, "run-1", 0)).toThrow(TypeError);
    });
});

describe("parseObjectKey", () => {
    it("returns the monitor id and kind for every key", () => {
        expect(parseObjectKey(learnShotKey(M, R, 2, "webp"))).toEqual({
            key: `captures/${M}/${R}/learn-2.webp`,
            prefix: "captures",
            kind: "learn",
            monitorId: M,
            runId: R,
            changeId: null,
            learnIndex: 2,
            subjectId: null,
            stepSeq: null,
            contentType: "image/webp",
        });
        expect(parseObjectKey(changeCropKey(M, R))).toMatchObject({
            prefix: "changes",
            kind: "crop",
            monitorId: M,
            changeId: R,
            contentType: "image/png",
        });
        expect(parseObjectKey(storageStateKey(M))).toMatchObject({
            prefix: "state",
            kind: "state",
            monitorId: M,
            contentType: "application/json",
        });
        expect(parseObjectKey(blocksKey(M, R))?.contentType).toBe(
            "application/gzip",
        );
    });

    it("reads a step screenshot key: the Monitor first, then the Run or Macro, then the step", () => {
        expect(parseObjectKey(stepShotKey(M, R, 7))).toEqual({
            key: `steps/${M}/${R}/7.webp`,
            prefix: "steps",
            kind: "step",
            // The web app checks ownership against this id before signing a read.
            monitorId: M,
            runId: null,
            changeId: null,
            learnIndex: null,
            subjectId: R,
            stepSeq: 7,
            contentType: "image/webp",
        });
        expect(parseObjectKey(`steps/${M}/${R}/0.webp`)?.stepSeq).toBe(0);
        expect(parseObjectKey(`steps/${M}/${R}/120.webp`)?.stepSeq).toBe(120);
    });

    it("rejects step keys of any other shape", () => {
        for (const key of [
            `steps/${M}/${R}/07.webp`, // one step, one key: no leading zeros
            `steps/${M}/${R}/-1.webp`,
            `steps/${M}/${R}/1.5.webp`,
            `steps/${M}/${R}/a.webp`,
            `steps/${M}/${R}/.webp`,
            `steps/${M}/${R}/7.png`,
            `steps/${M}/${R}/7.webp/x`,
            `steps/${M}/7.webp`,
            `steps/${M}/${R}/${R}/7.webp`,
            `steps/${M.toUpperCase()}/${R}/7.webp`,
            `steps/${M}/run-1/7.webp`,
        ]) {
            expect(parseObjectKey(key), key).toBeNull();
        }
    });

    it("rejects the old layout", () => {
        expect(parseObjectKey(`screenshots/${M}/${R}.png`)).toBeNull();
        expect(parseObjectKey(`diffs/${M}/${R}.png`)).toBeNull();
    });
});

describe("isAllowedListPrefix", () => {
    it("allows the known prefixes only", () => {
        expect(isAllowedListPrefix(`captures/${M}/`)).toBe(true);
        expect(isAllowedListPrefix("changes/")).toBe(true);
        expect(isAllowedListPrefix("state")).toBe(true);
        expect(isAllowedListPrefix(`steps/${M}/${R}/`)).toBe(true);
        expect(isAllowedListPrefix("stepsX/")).toBe(false);
        expect(isAllowedListPrefix("screenshots/")).toBe(false);
        expect(isAllowedListPrefix("captures/../x")).toBe(false);
        expect(isAllowedListPrefix("capturesX/")).toBe(false);
    });
});
