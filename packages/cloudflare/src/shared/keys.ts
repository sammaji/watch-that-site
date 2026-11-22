/**
 * Object keys are enforced rather than free-form so the bucket stays listable
 * by Monitor, lifecycle rules can target whole prefixes, and a caller cannot
 * escape the known layout. The first UUID in every key is the Monitor id,
 * which is what the web app checks ownership against before signing a read.
 *
 * Layout (all UUIDs lower-case):
 *
 * ```
 * captures/{monitor}/{run}/shot.{png|webp}
 * captures/{monitor}/{run}/learn-{0|1|2}.{png|webp}
 * captures/{monitor}/{run}/blocks.json.gz
 * changes/{monitor}/{change}.json.gz
 * changes/{monitor}/{change}-diff.png
 * changes/{monitor}/{change}-crop.png
 * state/{monitor}.json
 * steps/{monitor}/{run or macro}/{seq}.webp
 * ```
 *
 * `steps/` holds the screenshot taken after step `seq` of a Run's trace or of
 * a Macro recording; the second UUID is the Run's id or the Macro's.
 *
 * Mirrored in Go by `packages/cloudflare_go/r2/keys.go`; keep the two in sync.
 */

export type ObjectPrefix = "captures" | "changes" | "state" | "steps";

/** What an object is, which also fixes its content type. */
export type ObjectKind =
    "shot" | "learn" | "blocks" | "change" | "diff" | "crop" | "state" | "step";

export type ImageFormat = "png" | "webp";

export interface ParsedObjectKey {
    key: string;
    prefix: ObjectPrefix;
    kind: ObjectKind;
    monitorId: string;
    /** Set for `captures/` keys. */
    runId: string | null;
    /** Set for `changes/` keys. */
    changeId: string | null;
    /** 0–2 for `learn` keys, otherwise null. */
    learnIndex: number | null;
    /** For `steps/` keys: the Run or Macro the step belongs to, and its number. */
    subjectId: string | null;
    stepSeq: number | null;
    /** The only content type this key may be stored with. */
    contentType: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const CAPTURE_IMAGE = new RegExp(
    `^captures/(${UUID})/(${UUID})/(shot|learn-([0-2]))\\.(png|webp)$`,
);
const CAPTURE_BLOCKS = new RegExp(
    `^captures/(${UUID})/(${UUID})/blocks\\.json\\.gz$`,
);
const CHANGE_RECORD = new RegExp(`^changes/(${UUID})/(${UUID})\\.json\\.gz$`);
const CHANGE_IMAGE = new RegExp(
    `^changes/(${UUID})/(${UUID})-(diff|crop)\\.png$`,
);
const STORAGE_STATE = new RegExp(`^state/(${UUID})\\.json$`);
// A non-negative integer without leading zeros, so one step has one key.
const STEP_SHOT = new RegExp(
    `^steps/(${UUID})/(${UUID})/(0|[1-9][0-9]{0,8})\\.webp$`,
);
const UUID_ONLY = new RegExp(`^${UUID}$`);

export const KEY_FORMAT_HINT =
    "expected captures/{monitor}/{run}/{shot|learn-0|learn-1|learn-2}.{png|webp}, " +
    "captures/{monitor}/{run}/blocks.json.gz, changes/{monitor}/{change}.json.gz, " +
    "changes/{monitor}/{change}-{diff|crop}.png, state/{monitor}.json or " +
    "steps/{monitor}/{run or macro}/{seq}.webp with lower-case UUIDs";

export const CONTENT_TYPES = {
    png: "image/png",
    webp: "image/webp",
    json: "application/json",
    gzip: "application/gzip",
} as const;

/** Content types the Worker accepts on upload. */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(
    Object.values(CONTENT_TYPES),
);

export function parseObjectKey(raw: string): ParsedObjectKey | null {
    let m = CAPTURE_IMAGE.exec(raw);
    if (m !== null) {
        const [, monitorId = "", runId = "", name = "", index, format = ""] = m;
        const learn = name !== "shot";
        return {
            key: raw,
            prefix: "captures",
            kind: learn ? "learn" : "shot",
            monitorId,
            runId,
            changeId: null,
            learnIndex: learn ? Number(index) : null,
            subjectId: null,
            stepSeq: null,
            contentType: CONTENT_TYPES[format as ImageFormat],
        };
    }
    m = CAPTURE_BLOCKS.exec(raw);
    if (m !== null) {
        return {
            key: raw,
            prefix: "captures",
            kind: "blocks",
            monitorId: m[1] ?? "",
            runId: m[2] ?? "",
            changeId: null,
            learnIndex: null,
            subjectId: null,
            stepSeq: null,
            contentType: CONTENT_TYPES.gzip,
        };
    }
    m = CHANGE_RECORD.exec(raw);
    if (m !== null) {
        return {
            key: raw,
            prefix: "changes",
            kind: "change",
            monitorId: m[1] ?? "",
            runId: null,
            changeId: m[2] ?? "",
            learnIndex: null,
            subjectId: null,
            stepSeq: null,
            contentType: CONTENT_TYPES.gzip,
        };
    }
    m = CHANGE_IMAGE.exec(raw);
    if (m !== null) {
        return {
            key: raw,
            prefix: "changes",
            kind: m[3] === "crop" ? "crop" : "diff",
            monitorId: m[1] ?? "",
            runId: null,
            changeId: m[2] ?? "",
            learnIndex: null,
            subjectId: null,
            stepSeq: null,
            contentType: CONTENT_TYPES.png,
        };
    }
    m = STORAGE_STATE.exec(raw);
    if (m !== null) {
        return {
            key: raw,
            prefix: "state",
            kind: "state",
            monitorId: m[1] ?? "",
            runId: null,
            changeId: null,
            learnIndex: null,
            subjectId: null,
            stepSeq: null,
            contentType: CONTENT_TYPES.json,
        };
    }
    m = STEP_SHOT.exec(raw);
    if (m !== null) {
        return {
            key: raw,
            prefix: "steps",
            kind: "step",
            monitorId: m[1] ?? "",
            runId: null,
            changeId: null,
            learnIndex: null,
            subjectId: m[2] ?? "",
            stepSeq: Number(m[3]),
            contentType: CONTENT_TYPES.webp,
        };
    }
    return null;
}

function uuid(label: string, value: string): string {
    const lower = value.toLowerCase();
    if (!UUID_ONLY.test(lower)) {
        throw new TypeError(`${label} ${JSON.stringify(value)} is not a UUID`);
    }
    return lower;
}

function format(value: string): ImageFormat {
    if (value !== "png" && value !== "webp") {
        throw new TypeError(
            `image format must be png or webp, got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

/** `captures/{monitor}/{run}/shot.{format}` */
export function captureShotKey(
    monitorId: string,
    runId: string,
    imageFormat: ImageFormat,
): string {
    return `captures/${uuid("monitor id", monitorId)}/${uuid("run id", runId)}/shot.${format(imageFormat)}`;
}

/** `captures/{monitor}/{run}/learn-{index}.{format}`, index 0–2. */
export function learnShotKey(
    monitorId: string,
    runId: string,
    index: number,
    imageFormat: ImageFormat = "png",
): string {
    if (index !== 0 && index !== 1 && index !== 2) {
        throw new TypeError(`learn index must be 0, 1 or 2, got ${index}`);
    }
    return `captures/${uuid("monitor id", monitorId)}/${uuid("run id", runId)}/learn-${index}.${format(imageFormat)}`;
}

/** `captures/{monitor}/{run}/blocks.json.gz` */
export function blocksKey(monitorId: string, runId: string): string {
    return `captures/${uuid("monitor id", monitorId)}/${uuid("run id", runId)}/blocks.json.gz`;
}

/** `changes/{monitor}/{change}.json.gz` */
export function changeRecordKey(monitorId: string, changeId: string): string {
    return `changes/${uuid("monitor id", monitorId)}/${uuid("change id", changeId)}.json.gz`;
}

/** `changes/{monitor}/{change}-diff.png` */
export function changeDiffKey(monitorId: string, changeId: string): string {
    return `changes/${uuid("monitor id", monitorId)}/${uuid("change id", changeId)}-diff.png`;
}

/** `changes/{monitor}/{change}-crop.png` */
export function changeCropKey(monitorId: string, changeId: string): string {
    return `changes/${uuid("monitor id", monitorId)}/${uuid("change id", changeId)}-crop.png`;
}

/** `state/{monitor}.json` */
export function storageStateKey(monitorId: string): string {
    return `state/${uuid("monitor id", monitorId)}.json`;
}

/**
 * `steps/{monitor}/{run or macro}/{seq}.webp`: the screenshot after step
 * `seq` (a non-negative integer) of a Run or of a Macro recording.
 */
export function stepShotKey(
    monitorId: string,
    subjectId: string,
    seq: number,
): string {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > 999_999_999) {
        throw new TypeError(
            `step seq must be a non-negative integer, got ${seq}`,
        );
    }
    return `steps/${uuid("monitor id", monitorId)}/${uuid("run or macro id", subjectId)}/${seq}.webp`;
}

/**
 * Listing is restricted to the known prefixes, so it cannot enumerate
 * anything else in the bucket.
 */
export function isAllowedListPrefix(prefix: string): boolean {
    if (prefix.includes("..")) {
        return false;
    }
    return (["captures", "changes", "state", "steps"] as const).some(
        p => prefix === p || prefix.startsWith(`${p}/`),
    );
}
