/**
 * Object store in front of the `watchthatsite` R2 bucket.
 *
 * The browser worker uploads Captures through it, and the scheduler can read
 * and write through it too (its Worker-only mode). Objects are private: reads
 * need the bearer token or a short-lived signed URL, which the web app mints
 * after checking the viewer owns the Monitor in the key.
 *
 * See README.md for the full HTTP contract.
 */

import { requireBearer } from "./auth.js";
import { jsonError, methodNotAllowed } from "./http.js";
import {
    handleDelete,
    handleGet,
    handleHead,
    handleList,
    handlePut,
} from "./r2/index.js";

const OBJECT_PREFIX = "/objects/";

export default {
    async fetch(request, env): Promise<Response> {
        const url = new URL(request.url);

        try {
            if (url.pathname === "/health") {
                if (request.method !== "GET" && request.method !== "HEAD") {
                    return methodNotAllowed(["GET", "HEAD"]);
                }
                return Response.json({ ok: true });
            }

            if (url.pathname === "/objects") {
                if (request.method !== "GET") {
                    return methodNotAllowed(["GET"]);
                }
                const denied = await requireBearer(request, env);
                return denied ?? (await handleList(request, env));
            }

            if (url.pathname.startsWith(OBJECT_PREFIX)) {
                let key: string;
                try {
                    key = decodeURIComponent(
                        url.pathname.slice(OBJECT_PREFIX.length),
                    );
                } catch {
                    return jsonError(
                        400,
                        "invalid_key",
                        "Object key is not valid percent-encoding.",
                    );
                }

                switch (request.method) {
                    case "GET":
                        return await handleGet(request, env, key);
                    case "HEAD":
                        return await handleHead(request, env, key);
                    case "PUT": {
                        const denied = await requireBearer(request, env);
                        return denied ?? (await handlePut(request, env, key));
                    }
                    case "DELETE": {
                        const denied = await requireBearer(request, env);
                        return (
                            denied ?? (await handleDelete(request, env, key))
                        );
                    }
                    default:
                        return methodNotAllowed([
                            "GET",
                            "HEAD",
                            "PUT",
                            "DELETE",
                        ]);
                }
            }

            return jsonError(404, "not_found", `No route for ${url.pathname}.`);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Unknown error";
            console.error(
                JSON.stringify({
                    message: "unhandled error",
                    error: message,
                    method: request.method,
                    path: url.pathname,
                }),
            );
            return jsonError(500, "internal_error", "Internal server error.");
        }
    },
} satisfies ExportedHandler<Env>;
