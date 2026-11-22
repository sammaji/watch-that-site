/**
 * Loads `tests/.env` then the repo-root `.env` into process.env without
 * overriding variables that are already set. Import it for its side effect
 * before reading configuration.
 */
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

config({ path: resolve(testsDir, ".env"), quiet: true });
config({ path: resolve(testsDir, "..", ".env"), quiet: true });
