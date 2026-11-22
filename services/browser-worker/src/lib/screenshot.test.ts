import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
    gridDiff,
    isBlank,
    isBlankCapture,
    readPngSize,
} from "./screenshot.js";

function png(
    w: number,
    h: number,
    paint: (x: number, y: number) => [number, number, number],
): Buffer {
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const [r, g, b] = paint(x, y);
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = b;
            img.data[i + 3] = 255;
        }
    }
    return PNG.sync.write(img);
}

const white = (): [number, number, number] => [255, 255, 255];

describe("gridDiff", () => {
    it("finds no cells in identical images", () => {
        const a = png(64, 64, white);
        expect(gridDiff(a, a, 16)).toEqual([]);
    });

    it("merges differing cells into rectangles", () => {
        const a = png(64, 64, white);
        // A 20x20 change at (20, 20) touches cells (1..2, 1..2).
        const b = png(64, 64, (x, y) =>
            x >= 20 && x < 40 && y >= 20 && y < 40 ?
                [0, 0, 0]
            :   [255, 255, 255],
        );
        expect(gridDiff(a, b, 16)).toEqual([[16, 16, 32, 32]]);
    });

    it("keeps separate regions apart", () => {
        const a = png(64, 64, white);
        const b = png(64, 64, (x, y) =>
            (x < 4 && y < 4) || (x > 60 && y > 60) ?
                [0, 0, 0]
            :   [255, 255, 255],
        );
        expect(gridDiff(a, b, 16)).toEqual([
            [0, 0, 16, 16],
            [48, 48, 16, 16],
        ]);
    });
});

describe("isBlank", () => {
    it("flags a single-colour image", () => {
        expect(isBlank(png(100, 100, white))).toBe(true);
    });

    it("does not flag an image with content", () => {
        const img = png(100, 100, x => (x < 10 ? [0, 0, 0] : [255, 255, 255]));
        expect(isBlank(img)).toBe(false);
    });

    it("does not call a sparse text page blank when its text painted", () => {
        // 1 % ink overall, but 20 % of the 50x100 block area.
        const img = png(100, 100, (x, y) =>
            x < 10 && y < 10 ? [0, 0, 0] : [255, 255, 255],
        );
        expect(isBlank(img)).toBe(true);
        expect(isBlankCapture(img, 50 * 100)).toBe(false);
        expect(isBlankCapture(png(100, 100, white), 50 * 100)).toBe(true);
    });
});

describe("readPngSize", () => {
    it("reads the IHDR size", () => {
        expect(readPngSize(png(7, 3, white))).toEqual({ width: 7, height: 3 });
    });

    it("rejects non-PNG data", () => {
        expect(() =>
            readPngSize(Buffer.from("nope, not a png at all...")),
        ).toThrow("not a PNG");
    });
});
