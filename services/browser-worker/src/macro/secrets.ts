import { SECRET_REF } from "@watchthatsite/types";

/** A step refers to a secret the Monitor does not have. */
export class MissingSecretError extends Error {
    constructor(readonly secretName: string) {
        super(
            `the secret "${secretName}" is not set for this Monitor (add it under the Monitor's secrets)`,
        );
        this.name = "MissingSecretError";
    }
}

export type SecretReader = (name: string) => Promise<string | null>;

/**
 * The secrets of one replay or one recording.
 *
 * Values are read from the vault only when a step is about to type them, and
 * stay inside this object and the browser. `scrub` puts the placeholder back
 * wherever a value shows up in text that leaves the worker: error messages,
 * run_steps rows, and everything sent to a model.
 */
export class SecretSession {
    private readonly values = new Map<string, string>();

    constructor(private readonly read: SecretReader) {}

    static refs(value: string): string[] {
        return [...value.matchAll(SECRET_REF)].map(m => m[1]!);
    }

    /** `value` with every `{{secret:name}}` replaced by the secret. */
    async expand(value: string): Promise<string> {
        for (const name of SecretSession.refs(value)) {
            if (this.values.has(name)) continue;
            const secret = await this.read(name);
            if (secret === null) throw new MissingSecretError(name);
            this.values.set(name, secret);
        }
        return value.replace(SECRET_REF, (_, name: string) =>
            this.values.get(name)!,
        );
    }

    /** `text` with every secret value seen so far replaced by its placeholder. */
    scrub(text: string): string {
        if (this.values.size === 0 || text === "") return text;
        // Longest first, so a secret that contains another is replaced whole.
        const entries = [...this.values.entries()]
            .filter(([, value]) => value.length >= 3)
            .sort((a, b) => b[1].length - a[1].length);
        let out = text;
        for (const [name, value] of entries) {
            out = out.split(value).join(`{{secret:${name}}}`);
        }
        return out;
    }
}
