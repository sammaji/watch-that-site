import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// The suites that need Postgres and the vault (and the opt-in real-model
// tests) read the same `.env` the service runs with. Only what they need is
// passed on; without the file those suites skip themselves.
const wanted =
    /^(POSTGRES_(USER|PASSWORD|HOST|PORT|DATABASE)|DATABASE_URL|ENCRYPTION_KEY|TEST_OPENAI_API_KEY)$/;
const fileEnv =
    existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const env = Object.fromEntries(
    Object.entries(fileEnv).filter(
        ([name, value]) => wanted.test(name) && value !== undefined,
    ),
) as Record<string, string>;

export default defineConfig({
    test: {
        // `build/` holds compiled output of these same tests. Without this the
        // suite runs every test twice, and a stale build reports failures for
        // source that no longer exists.
        include: ["src/**/*.test.ts"],
        env,
        // Real Chromium, a real database and several page loads per test.
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
});
