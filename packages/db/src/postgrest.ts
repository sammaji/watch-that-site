import { PostgrestClient } from "@supabase/postgrest-js";

/**
 * Creates a new PostgrestClient instance configured with authorization headers.
 * This client is used to interact with the Supabase PostgREST API (Postgres REST endpoint).
 *
 * @param {string} token - The JWT (JSON Web Token) used for authorization.
 * @returns {PostgrestClient} A configured PostgrestClient instance.
 */
export function _createPostgrestClient(token: string) {
    const url = process.env.NEXT_PUBLIC_POSTGREST_URL;
    if (!url) {
        throw new Error("NEXT_PUBLIC_POSTGREST_URL is not configured.");
    }
    return new PostgrestClient(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
        },
    });
}
