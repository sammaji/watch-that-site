/** Code shared by the Worker and the Node client. Nothing here touches the Workers runtime. */

export { isErrorBody } from "./contract.js";
export type { ErrorBody, ObjectListing, StoredObject } from "./contract.js";
export {
    ALLOWED_CONTENT_TYPES,
    CONTENT_TYPES,
    KEY_FORMAT_HINT,
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
} from "./keys.js";
export type {
    ImageFormat,
    ObjectKind,
    ObjectPrefix,
    ParsedObjectKey,
} from "./keys.js";
export {
    objectSignature,
    signObjectUrl,
    signObjectUrlFor,
    signingPayload,
} from "./signing.js";
