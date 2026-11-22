import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Both are secrets in real environments; tests supply fixed values
            // so they never depend on a local .dev.vars file.
            miniflare: {
                bindings: {
                    R2_API_TOKEN: "test-token",
                    R2_SIGNING_SECRET: "test-signing-secret",
                },
            },
        }),
    ],
});
