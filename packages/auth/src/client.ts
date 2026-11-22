"use client";

import { jwtClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { nextCookies } from "better-auth/next-js";

export const authClient = createAuthClient({
    baseURL:
        typeof window === "undefined" ?
            (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL)
        :   undefined,
    fetchOptions: {
        credentials: "include",
        auth: {
            type: "Bearer",
            token: () => {
                try {
                    const token = localStorage.getItem("bearer_token") || "";
                    return token;
                } catch {
                    console.log(
                        "Failed to get from localStorage, localStorage does not exists. Make sure you are running this on a browser.",
                    );
                    return "";
                }
            },
        },
        onSuccess: ctx => {
            const authToken = ctx.response.headers.get("set-auth-token");
            try {
                if (authToken) localStorage.setItem("bearer_token", authToken);
            } catch {
                console.log(
                    "Failed to set to localStorage, localStorage does not exists. Make sure you are running this on a browser.",
                );
            }
        },
    },
    plugins: [jwtClient(), nextCookies()],
});
