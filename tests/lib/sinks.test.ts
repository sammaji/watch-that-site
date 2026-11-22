import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AI_VERDICT, SinkServer, type SinkRequest } from "./sinks";

let sinks: SinkServer;
let base: string;

async function post(path: string, body: unknown, init: RequestInit = {}) {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
        ...init,
    });
}

async function listRequests(prefix = "") {
    const res = await fetch(`${base}/_requests?path=${encodeURIComponent(prefix)}`);
    return ((await res.json()) as { requests: SinkRequest[] }).requests;
}

function chatBody(diff: string) {
    return {
        model: "anthropic/claude-haiku-4-5-20251001",
        messages: [
            { role: "system", content: [{ type: "text", text: "judge" }] },
            { role: "user", content: [{ type: "text", text: diff }] },
        ],
        response_format: { type: "json_schema" },
    };
}

async function aiContent(res: Response) {
    const payload = (await res.json()) as {
        choices: { message: { content: string } }[];
    };
    return payload.choices[0]!.message.content;
}

beforeAll(async () => {
    sinks = await new SinkServer().start(0, "127.0.0.1");
    base = sinks.url;
});

afterAll(async () => {
    await sinks.stop();
});

beforeEach(async () => {
    await fetch(`${base}/_requests`, { method: "DELETE" });
});

describe("sink server", () => {
    it("records slack, discord, webhook and email requests by path", async () => {
        expect((await post("/slack/s1", { text: "hi" })).status).toBe(200);
        expect(await (await post("/slack/s1", { text: "again" })).text()).toBe("ok");
        expect((await post("/discord/d1", { content: "x" })).status).toBe(204);
        expect((await post("/webhook/w1", { id: "c1" }, { headers: { "content-type": "application/json", "x-signature": "abc" } })).status).toBe(200);
        expect((await post("/email", { to: ["a@b.c"], subject: "S" })).status).toBe(200);

        expect(await listRequests("/slack/")).toHaveLength(2);
        expect(await listRequests("/slack/s1")).toHaveLength(2);
        expect(await listRequests("/discord/")).toHaveLength(1);
        expect(await listRequests("/email")).toHaveLength(1);

        const [hook] = await listRequests("/webhook/w1");
        expect(hook!.json).toEqual({ id: "c1" });
        expect(hook!.headers["x-signature"]).toBe("abc");
        expect(hook!.method).toBe("POST");
        expect(await listRequests()).toHaveLength(5);
    });

    it("keeps the raw body when it is not JSON", async () => {
        await post("/webhook/raw", "plain text", { headers: { "content-type": "text/plain" } });
        const [req] = await listRequests("/webhook/raw");
        expect(req!.body).toBe("plain text");
        expect(req!.json).toBeNull();
    });

    it("clears recorded requests on DELETE", async () => {
        await post("/slack/s1", {});
        await fetch(`${base}/_requests`, { method: "DELETE" });
        expect(await listRequests()).toHaveLength(0);
    });

    it("404s unknown paths and does not record them", async () => {
        expect((await post("/nope", {})).status).toBe(404);
        expect((await post("/slack/", {})).status).toBe(404);
        expect(await listRequests()).toHaveLength(0);
    });

    it("answers /ai with an important verdict by default", async () => {
        const res = await post("/ai", chatBody("+ $59"));
        expect(res.status).toBe(200);
        expect(JSON.parse(await aiContent(res))).toEqual(DEFAULT_AI_VERDICT);
        const alt = await post("/ai/v1/chat/completions", chatBody("x"));
        expect(JSON.parse(await aiContent(alt)).important).toBe(true);
        expect(await listRequests("/ai")).toHaveLength(2);
    });

    it("uses the first matching script", async () => {
        await post("/_script", { match: "$59", response: { important: false, score: 5, summary: "not a decrease", evidence: ["$59"] } });
        await post("/_script", { match: "$59", response: { important: true } });
        await post("/_script", { match: "Enterprise", response: "invalid" });

        const first = JSON.parse(await aiContent(await post("/ai", chatBody("- $49 + $59"))));
        expect(first).toMatchObject({ important: false, score: 5, summary: "not a decrease" });

        const invalid = await aiContent(await post("/ai", chatBody("+ Enterprise")));
        expect(() => JSON.parse(invalid)).toThrow();

        const fallback = JSON.parse(await aiContent(await post("/ai", chatBody("other"))));
        expect(fallback.important).toBe(true);
    });

    it("rejects malformed scripts", async () => {
        expect((await post("/_script", { match: "x" })).status).toBe(400);
        expect((await post("/_script", { match: "x", response: "later" })).status).toBe(400);
    });

    it("holds the request open for a timeout script", async () => {
        await post("/_script", { match: "slow", response: "timeout" });
        const controller = new AbortController();
        const pending = post("/ai", chatBody("slow diff"), { signal: controller.signal });
        const outcome = await Promise.race([
            pending.then(() => "answered", () => "aborted"),
            new Promise(resolve => setTimeout(() => resolve("still waiting"), 400)),
        ]);
        expect(outcome).toBe("still waiting");
        controller.abort();
        await pending.catch(() => undefined);
        // The request was still recorded.
        expect(await listRequests("/ai")).toHaveLength(1);
    });

    it("clears scripts together with requests", async () => {
        await post("/_script", { match: "", response: { important: false } });
        await fetch(`${base}/_requests`, { method: "DELETE" });
        const verdict = JSON.parse(await aiContent(await post("/ai", chatBody("x"))));
        expect(verdict.important).toBe(true);
    });

    it("reports health", async () => {
        const res = await fetch(`${base}/_health`);
        expect(await res.json()).toMatchObject({ ok: true });
    });
});
