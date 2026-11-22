import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    CHANGE_RECORD_VERSION,
    countedOps,
    type ChangeRecord,
} from "./change-record";

// The same fixture the Go suite decodes with DisallowUnknownFields.
const golden = fileURLToPath(
    new URL(
        "../../../services/scheduler/internal/changerecord/testdata/change_record.json",
        import.meta.url,
    ),
);

/**
 * Every key the TypeScript type declares, per object path. Listing them here
 * makes an extra or missing field in the Go output fail this test, which is
 * the TypeScript side of the strict-decoding contract.
 */
const shape: Record<string, string[]> = {
    "": [
        "version",
        "id",
        "monitor",
        "from",
        "to",
        "status",
        "summary",
        "items",
        "ignored",
        "why",
        "suppressed_by",
        "magnitude",
        "text",
        "visual",
        "agent",
        "sections",
        "cumulative",
        "created_at",
    ],
    monitor: ["id", "name", "url", "instructions"],
    from: ["run_id", "at", "screenshot", "blocks"],
    to: ["run_id", "at", "screenshot", "blocks"],
    magnitude: [
        "words_added",
        "words_removed",
        "blocks_changed",
        "moves",
        "change_ratio",
        "net_added",
        "net_removed",
        "area_ratio",
    ],
    text: ["ops", "ignored_count", "masked"],
    visual: [
        "regions",
        "shift",
        "area_ratio",
        "size_before",
        "size_after",
        "diff_image",
        "crop",
    ],
    "visual.shift": ["from_y", "dy"],
    agent: [
        "relevant",
        "importance",
        "model",
        "unavailable",
        "error",
        "input_tokens",
        "output_tokens",
        "steps",
    ],
    cumulative: ["from", "text", "magnitude"],
    "cumulative.from": ["run_id", "at", "screenshot", "blocks"],
    "cumulative.text": ["ops", "ignored_count", "masked"],
};

/** List items whose keys must all be present. */
const exact: Record<string, string[]> = {
    "items[]": [
        "title",
        "before",
        "after",
        "kind",
        "matches",
        "ops",
        "regions",
        "rect_before",
        "rect_after",
    ],
    "ignored[]": ["note", "reason"],
    "sections[]": ["id", "name", "how"],
};

/** List items with optional keys: none may be undeclared. */
const optional: Record<string, string[]> = {
    "text.ops[]": [
        "op",
        "block_id",
        "from_block_id",
        "path",
        "tag",
        "rect",
        "from_rect",
        "text",
        "old_text",
        "tokens",
        "whole",
        "from",
        "to",
        "context_before",
        "context_after",
        "masked",
        "section",
    ],
    "cumulative.text.ops[]": [
        "op",
        "block_id",
        "from_block_id",
        "path",
        "tag",
        "rect",
        "from_rect",
        "text",
        "old_text",
        "tokens",
        "whole",
        "from",
        "to",
        "context_before",
        "context_after",
        "masked",
        "section",
    ],
    "why[]": ["kind", "reason", "detail"],
    "visual.regions[]": [
        "box",
        "kind",
        "pixels",
        "blocks",
        "from_box",
        "section",
    ],
};

function at(obj: unknown, path: string): unknown {
    return path === "" ? obj : (
            path.split(".").reduce<any>((o, k) => o?.[k], obj)
        );
}

describe("Change Record contract", () => {
    const record = JSON.parse(readFileSync(golden, "utf8")) as ChangeRecord;

    it("has exactly the declared keys", () => {
        for (const [path, keys] of Object.entries(shape)) {
            expect(
                Object.keys(at(record, path) as object).sort(),
                path,
            ).toEqual([...keys].sort());
        }
    });

    it("has exactly the declared keys in list items", () => {
        for (const [path, keys] of Object.entries(exact)) {
            const list = at(record, path.slice(0, -2)) as object[];
            expect(list.length, path).toBeGreaterThan(0);
            for (const item of list) {
                expect(Object.keys(item).sort(), path).toEqual(
                    [...keys].sort(),
                );
            }
        }
    });

    it("has no undeclared keys in list items", () => {
        for (const [path, allowed] of Object.entries(optional)) {
            const list = at(record, path.slice(0, -2)) as object[];
            expect(list.length, path).toBeGreaterThan(0);
            for (const item of list) {
                for (const key of Object.keys(item)) {
                    expect(allowed, `${path}.${key}`).toContain(key);
                }
            }
        }
    });

    it("decodes into the TypeScript type", () => {
        expect(record.version).toBe(CHANGE_RECORD_VERSION);
        expect(record.version).toBe(2);
        expect(record.status).toBe("change");
        expect(record.monitor.instructions).toContain("price");

        // The agent's answer.
        expect(record.summary).toBe(
            "The Pro plan went from $49 to $59 per month.",
        );
        expect(record.items.map(i => i.kind)).toEqual(["text", "visual"]);
        expect(record.agent?.relevant).toBe(true);
        expect(record.agent?.importance).toBe("high");
        expect(record.ignored[0]?.reason).toBe("Not a plan price.");

        // The evidence under it: one counted op and one ignored one.
        expect(record.text?.ops.map(op => op.op)).toEqual([
            "modify",
            "ignored",
        ]);
        expect(countedOps(record.text)).toHaveLength(1);
        expect(record.text?.ops[0]?.tokens?.map(t => t.op)).toEqual([
            "=",
            "-",
            "+",
            "=",
        ]);
        expect(record.visual?.regions[0]?.box).toHaveLength(4);
        expect(record.visual?.regions[0]?.from_box).toHaveLength(4);
    });

    it("lets every item be traced to its evidence and its Section", () => {
        const [text, visual] = record.items;
        const op = record.text!.ops[text!.ops[0]!]!;
        expect(text!.rect_after).toEqual(op.rect);
        expect(text!.rect_before).toEqual(op.from_rect);
        const region = record.visual!.regions[visual!.regions[0]!]!;
        expect(visual!.rect_after).toEqual(region.box);
        expect(visual!.rect_before).toEqual(region.from_box);

        const names = new Map(record.sections?.map(s => [s.id, s.name]));
        expect(names.get(op.section!)).toBe("Pricing table");
        expect(names.get(region.section!)).toBe("Pricing table");
        expect(record.sections?.map(s => s.how)).toEqual(["both", "ignore"]);
        expect(names.get(record.text!.ops[1]!.section!)).toBe("Testimonials");
    });
});
