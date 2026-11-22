"use client";

import { useState } from "react";

export function ActionsClient() {
    const [message, setMessage] = useState("idle");

    async function callRelativeFetch() {
        const response = await fetch("/test/api/echo?source=button", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ clicked: true }),
        });
        const payload = (await response.json()) as { proxied: string };
        setMessage(payload.proxied);
    }

    return (
        <section data-testid="proxy-actions-page">
            <h1>Proxy action fixture</h1>
            <button id="relative-fetch-button" onClick={callRelativeFetch}>
                Call relative fetch
            </button>
            <output id="fetch-result">{message}</output>
        </section>
    );
}
