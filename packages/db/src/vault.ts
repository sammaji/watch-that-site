import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    randomUUID,
} from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { sql as defaultSql } from "./pool";

/**
 * The secrets vault: each account's gateway virtual key and the passwords a
 * Macro types, encrypted at rest in the `secrets` table.
 *
 * Each value is sealed with AES-256-GCM under ENCRYPTION_KEY (32 bytes, hex).
 * The row's id and purpose are bound in as additional authenticated data, so a
 * ciphertext copied onto another row, or read back for another purpose, fails
 * to decrypt. Stored as `v1:<iv>:<tag>:<data>` with base64 parts.
 *
 * Server code only. Never import this from a client component, and never send
 * a decrypted value to the browser or to a model.
 */

export type SecretPurpose = "virtual_key" | "macro_secret";

export interface SecretOwner {
    userId: string;
}

type Db = Sql | TransactionSql;

const VERSION = "v1";
const IV_BYTES = 12;

function encryptionKey(): Buffer {
    const hex = process.env.ENCRYPTION_KEY ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(
            "ENCRYPTION_KEY must be 32 bytes as 64 hex characters (generate one with `openssl rand -hex 32`)",
        );
    }
    return Buffer.from(hex, "hex");
}

function aad(id: string, purpose: SecretPurpose): Buffer {
    return Buffer.from(`${id}:${purpose}`, "utf8");
}

/** Seals `value` for the secrets row `id`. */
export function encryptSecret(
    id: string,
    purpose: SecretPurpose,
    value: string,
): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    cipher.setAAD(aad(id, purpose));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        VERSION,
        iv.toString("base64"),
        tag.toString("base64"),
        data.toString("base64"),
    ].join(":");
}

/** Opens a ciphertext sealed by `encryptSecret` for the same id and purpose. */
export function decryptSecret(
    id: string,
    purpose: SecretPurpose,
    ciphertext: string,
): string {
    const [version, iv, tag, data] = ciphertext.split(":");
    if (version !== VERSION || !iv || !tag || data === undefined) {
        throw new Error("Secret is not in a format this version can read");
    }
    const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey(),
        Buffer.from(iv, "base64"),
    );
    decipher.setAAD(aad(id, purpose));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(data, "base64")),
        decipher.final(),
    ]).toString("utf8");
}

/** The last four characters, for display next to a stored secret. */
export function secretHint(value: string): string {
    const trimmed = value.trim();
    return trimmed.length <= 8 ? "" : trimmed.slice(-4);
}

/** Stores a new secret and returns its id. */
export async function putSecret(
    owner: SecretOwner,
    purpose: SecretPurpose,
    value: string,
    db: Db = defaultSql,
): Promise<string> {
    const id = randomUUID();
    await db`
        INSERT INTO secrets (id, user_id, purpose, ciphertext)
        VALUES (${id}, ${owner.userId}, ${purpose}, ${encryptSecret(id, purpose, value)})
    `;
    return id;
}

/** Replaces a stored secret's value in place. */
export async function replaceSecret(
    id: string,
    purpose: SecretPurpose,
    value: string,
    db: Db = defaultSql,
): Promise<void> {
    await db`
        UPDATE secrets
        SET ciphertext = ${encryptSecret(id, purpose, value)}, updated_at = NOW()
        WHERE id = ${id} AND purpose = ${purpose}
    `;
}

/** Reads and decrypts a secret. Throws when it does not exist. */
export async function getSecret(
    id: string,
    purpose: SecretPurpose,
    db: Db = defaultSql,
): Promise<string> {
    const rows = await db<{ ciphertext: string }[]>`
        SELECT ciphertext FROM secrets WHERE id = ${id} AND purpose = ${purpose}
    `;
    const row = rows[0];
    if (!row) throw new Error("Secret not found");
    return decryptSecret(id, purpose, row.ciphertext);
}

export async function deleteSecret(
    id: string,
    db: Db = defaultSql,
): Promise<void> {
    await db`DELETE FROM secrets WHERE id = ${id}`;
}
