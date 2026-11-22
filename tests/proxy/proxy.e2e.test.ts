import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitFor } from "../lib/utils";

const API_KEY = "proxy-e2e-secret";
const PROXY_PREFIX = "/api/v1/proxy";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testsDir, "../../");
const samplePagesDir = path.join(rootDir, "apps/sample-pages");
const proxyDir = path.join(rootDir, "services/proxy");

let samplePages: ManagedProcess;
let proxy: ManagedProcess;
let samplePort: number;
let proxyPort: number;

class ManagedProcess {
    readonly output: string[] = [];

    constructor(
        readonly name: string,
        readonly child: ChildProcessWithoutNullStreams,
    ) {
        child.stdout.on("data", chunk => this.output.push(String(chunk)));
        child.stderr.on("data", chunk => this.output.push(String(chunk)));
    }

    async stop() {
        if (this.child.exitCode !== null || this.child.signalCode !== null)
            return;
        this.child.kill("SIGTERM");
        await Promise.race([
            new Promise<void>(resolve =>
                this.child.once("exit", () => resolve()),
            ),
            new Promise<void>(resolve => setTimeout(resolve, 3_000)),
        ]);
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill("SIGKILL");
        }
    }

    logs() {
        return this.output.join("");
    }
}

async function getOpenPort() {
    return new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() =>
                    reject(new Error("Failed to allocate port")),
                );
                return;
            }
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForHttp(url: string, headers?: HeadersInit) {
    await waitFor(
        url,
        async () => {
            const response = await fetch(url, { headers });
            return response.ok ? response : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 500 },
    );
}

function startProcess(
    name: string,
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
    });
    return new ManagedProcess(name, child);
}

function targetHost() {
    return `localhost:${samplePort}`;
}

function proxyUrl(pathname: string) {
    return `http://127.0.0.1:${proxyPort}${PROXY_PREFIX}/http/${targetHost()}${pathname}`;
}

function directUrl(pathname: string) {
    return `http://127.0.0.1:${samplePort}${pathname}`;
}

async function proxyFetch(pathname: string, init?: RequestInit) {
    return fetch(proxyUrl(pathname), {
        ...init,
        headers: { "x-api-key": API_KEY, ...init?.headers },
    });
}

function normalizeHtml(value: string) {
    return value.replace(/\s+/g, " ").trim();
}

function extractContentDiv(html: string) {
    const match = /<div id="content-under-test">([\s\S]*?)<\/div>/.exec(html);
    if (!match) throw new Error(`content div not found in html:\n${html}`);
    return normalizeHtml(match[0]);
}

beforeAll(async () => {
    [samplePort, proxyPort] = await Promise.all([getOpenPort(), getOpenPort()]);

    samplePages = startProcess(
        "sample-pages",
        "pnpm",
        [
            "exec",
            "next",
            "dev",
            "-p",
            String(samplePort),
            "--hostname",
            "127.0.0.1",
        ],
        { cwd: samplePagesDir, env: { NEXT_TELEMETRY_DISABLED: "1" } },
    );
    await waitForHttp(directUrl("/test/html"));

    proxy = startProcess("proxy", "go", ["run", "."], {
        cwd: proxyDir,
        env: {
            ADDR: `127.0.0.1:${proxyPort}`,
            ALLOW_PRIVATE_TARGETS: "true",
            PROXY_API_KEY: API_KEY,
        },
    });
    await waitForHttp(`http://127.0.0.1:${proxyPort}/health`, {
        "x-api-key": API_KEY,
    });
}, 90_000);

afterAll(async () => {
    await Promise.all([proxy?.stop(), samplePages?.stop()]);
});

describe("proxy e2e", () => {
    describe("HTML documents", () => {
        it("preserves stable body content while injecting the runtime", async () => {
            const [directResponse, proxiedResponse] = await Promise.all([
                fetch(directUrl("/test/html")),
                proxyFetch("/test/html"),
            ]);

            expect(proxiedResponse.status).toBe(200);
            expect(proxiedResponse.headers.get("content-type")).toContain(
                "text/html",
            );

            const directHtml = await directResponse.text();
            const proxiedHtml = await proxiedResponse.text();

            expect(extractContentDiv(proxiedHtml)).toBe(
                extractContentDiv(directHtml),
            );
            expect(proxiedHtml).toContain("msg:preview-ready");
        });

        it("rewrites document navigation and asset attributes through the proxy", async () => {
            const response = await proxyFetch("/test/html");
            const html = await response.text();
            const host = targetHost();

            expect(html).toContain(
                `${PROXY_PREFIX}/http/${host}/test/html/next`,
            );
            expect(html).toContain(
                `${PROXY_PREFIX}/https/example.com/external`,
            );
            expect(html).toContain(`href="mailto:fixture@example.com"`);
            expect(html).toContain(
                `${PROXY_PREFIX}/http/${host}/test/api/echo`,
            );
            expect(html).toContain(
                `${PROXY_PREFIX}/http/${host}/test/assets/proxy-fixture.svg`,
            );
            expect(html).toContain(
                `${PROXY_PREFIX}/http/${host}/test/assets/proxy-fixture-small.svg 1x`,
            );
            expect(html).toContain(
                `${PROXY_PREFIX}/http/${host}/test/assets/proxy-fixture-large.svg 2x`,
            );
        });
    });

    describe("non-HTML assets", () => {
        it("rewrites CSS url() references and leaves data URLs untouched", async () => {
            const response = await proxyFetch("/test/assets/proxy-fixture.css");
            const css = await response.text();
            const host = targetHost();

            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toContain("text/css");
            expect(css).toContain(
                `url("${PROXY_PREFIX}/http/${host}/test/assets/proxy-fixture.svg")`,
            );
            expect(css).toContain(
                `url("${PROXY_PREFIX}/http/${host}/test/assets/proxy-fixture-small.svg")`,
            );
            expect(css).toContain("url(data:image/png;base64,abc)");
        });

        it("passes binary-like assets through without HTML runtime injection", async () => {
            const response = await proxyFetch("/test/assets/proxy-fixture.svg");
            const svg = await response.text();

            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toContain(
                "image/svg+xml",
            );
            expect(svg).toContain("<svg");
            expect(svg).not.toContain("msg:preview-ready");
        });
    });

    describe("forwarded requests", () => {
        it("forwards methods, query strings, and request bodies through the proxy", async () => {
            const response = await proxyFetch("/test/api/echo?source=e2e", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ from: "proxy-test" }),
            });

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                method: "POST",
                path: "/test/api/echo",
                search: "?source=e2e",
                proxied: "through-proxy",
                body: JSON.stringify({ from: "proxy-test" }),
            });
        });

        it("rejects requests that do not include the proxy API key", async () => {
            const response = await fetch(proxyUrl("/test/api/echo"));

            expect(response.status).toBe(401);
            await expect(response.json()).resolves.toEqual({
                error: "unauthorized",
            });
        });
    });
});
