/**
 * The JSON shapes the Worker speaks over HTTP.
 *
 * These live in `shared/` because both sides depend on them: the Worker
 * produces them in `src/r2/handlers.ts`, and the Node client in `src/client/`
 * parses them. Keeping one definition is what stops the two drifting.
 */

/** Metadata for a stored object, as returned by `PUT` and by each `GET /objects` row. */
export interface StoredObject {
    key: string;
    size: number;
    etag: string;
    uploaded: string;
    content_type: string | null;
    /**
     * Always `""`. Objects are private since WP3: there is no public link to
     * hand out. Readers either use the bearer token or a signed URL built with
     * `signObjectUrl` (or `/api/v1/objects/{key}` in the web app). Kept so the
     * response shape stays stable.
     */
    url: string;
}

/** One page of `GET /objects?prefix=…`. */
export interface ObjectListing {
    objects: StoredObject[];
    /** Pass back as `cursor` to continue; null when the listing is complete. */
    cursor: string | null;
    truncated: boolean;
}

/** Every non-2xx response carries this shape. */
export interface ErrorBody {
    error: {
        code: string;
        message: string;
    };
}

/** Narrows an unknown JSON body to an {@link ErrorBody}. */
export function isErrorBody(value: unknown): value is ErrorBody {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const error = (value as { error?: unknown }).error;
    return (
        typeof error === "object" &&
        error !== null &&
        typeof (error as { code?: unknown }).code === "string" &&
        typeof (error as { message?: unknown }).message === "string"
    );
}
