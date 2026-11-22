import type { MacroStep } from "@watchthatsite/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createFixture, hasDb, type Fixture } from "../testing/db.js";
import { NoConnectionError } from "./store.js";

describe.skipIf(!hasDb)("PgStore", () => {
    let fx: Fixture;
    const steps: MacroStep[] = [
        {
            type: "fill",
            intent: "Type the password",
            selectors: ['label="Password"'],
            value: "{{secret:password}}",
            optional: true,
            timeout_ms: 3000,
        },
        {
            type: "click",
            intent: "Open Billing",
            selectors: ['role=tab[name="Billing"]'],
        },
    ];

    beforeAll(async () => {
        fx = await createFixture({
            url: "https://example.test/app",
            gatewayUrl: "http://gateway.test:5203/",
            virtualKey: "sk-bf-test-key-abcdef123456",
            connection: {
                kind: "openai",
                model: "openai/model-a",
                models: ["openai/model-a", "openai/model-b"],
            },
        });
    });

    afterAll(async () => {
        await fx?.cleanup();
        await closeDb();
    });

    it("reads a Monitor and its Macro with step fields untouched", async () => {
        const monitor = await fx.store.getMonitor(fx.monitorId);
        expect(monitor).toMatchObject({
            id: fx.monitorId,
            userId: fx.userId,
            url: "https://example.test/app",
            connectionId: fx.connectionId,
            model: "openai/model-a",
            viewportW: 800,
            viewportH: 600,
            blockAds: false,
        });
        const id = await fx.addMacro(steps);
        const macro = await fx.store.getMacro(id);
        // `timeout_ms` must come back as `timeout_ms`, not `timeoutMs`.
        expect(macro?.steps).toEqual(steps);
        expect(macro).toMatchObject({
            monitorId: fx.monitorId,
            status: "active",
            version: 1,
        });
        expect(
            await fx.store.getMacro("11111111-2222-4333-8444-555555555555"),
        ).toBeNull();
    });

    it("reads secrets by name through the vault", async () => {
        await fx.addSecret("password", "hunter2-hunter2");
        expect(await fx.store.secretNames(fx.monitorId)).toEqual(["password"]);
        expect(await fx.store.readSecret(fx.monitorId, "password")).toBe(
            "hunter2-hunter2",
        );
        expect(await fx.store.readSecret(fx.monitorId, "pin")).toBeNull();
        // What is stored is not the value.
        const rows = await fx.sql<
            { ciphertext: string }[]
        >`SELECT ciphertext FROM secrets WHERE user_id = ${fx.userId}`;
        expect(rows.every(r => !r.ciphertext.includes("hunter2"))).toBe(true);
    });

    it("resolves the Monitor's connection to the gateway, with the virtual key decrypted", async () => {
        const owner = { userId: fx.userId };
        const resolved = await fx.store.resolveConnection({
            ...owner,
            connectionId: fx.connectionId,
            model: "openai/model-b",
        });
        expect(resolved).toEqual({
            id: fx.connectionId,
            kind: "openai",
            name: "Test connection",
            baseUrl: "http://gateway.test:5203/v1",
            apiKey: "sk-bf-test-key-abcdef123456",
            keyId: expect.stringMatching(/^key-/),
            managed: false,
            model: "openai/model-b",
        });
    });

    it("falls back to the owner's first enabled connection and its default model", async () => {
        const owner = { userId: fx.userId };
        // No model on the Monitor: the connection's default.
        expect(
            (
                await fx.store.resolveConnection({
                    ...owner,
                    connectionId: fx.connectionId,
                    model: null,
                })
            ).model,
        ).toBe("openai/model-a");
        // No connection on the Monitor: the owner's first, with its default.
        expect(
            await fx.store.resolveConnection({
                ...owner,
                connectionId: null,
                model: null,
            }),
        ).toMatchObject({ id: fx.connectionId, model: "openai/model-a" });
        // A connection that is gone: the model name is not carried over.
        expect(
            await fx.store.resolveConnection({
                ...owner,
                connectionId: "11111111-2222-4333-8444-555555555555",
                model: "some-other-model",
            }),
        ).toMatchObject({ id: fx.connectionId, model: "openai/model-a" });
    });

    it("prefers the owner's own key to the platform credit, and uses the credit otherwise", async () => {
        const other = await createFixture({
            url: "https://example.test/",
            gatewayUrl: "http://gateway.test:5203",
            connection: {
                kind: "openai",
                managed: true,
                model: "wts/wts-pro",
                models: ["wts/wts-pro", "wts/wts-mini"],
            },
        });
        try {
            const owner = { userId: other.userId };
            const credit = await other.store.resolveConnection({
                ...owner,
                connectionId: null,
                model: null,
            });
            expect(credit).toMatchObject({
                id: other.connectionId,
                managed: true,
                keyId: null,
                model: "wts/wts-pro",
                baseUrl: "http://gateway.test:5203/v1",
            });

            // An own Anthropic key added later wins for a Monitor without a
            // connection, and is reached through the same gateway API.
            const rows = await other.sql<{ id: string }[]>`
                INSERT INTO provider_connections
                    (user_id, kind, name, gateway_provider, gateway_key_id,
                     models, default_model)
                VALUES (${other.userId}, 'anthropic', 'Own', 'anthropic', 'key-own',
                        ${other.sql.json(["anthropic/claude-x"])}, 'anthropic/claude-x')
                RETURNING id
            `;
            expect(
                await other.store.resolveConnection({
                    ...owner,
                    connectionId: null,
                    model: null,
                }),
            ).toMatchObject({
                id: rows[0]!.id,
                kind: "anthropic",
                managed: false,
                keyId: "key-own",
                model: "anthropic/claude-x",
                baseUrl: "http://gateway.test:5203/v1",
            });
            // The Monitor's own choice still holds.
            expect(
                await other.store.resolveConnection({
                    ...owner,
                    connectionId: other.connectionId,
                    model: "wts/wts-mini",
                }),
            ).toMatchObject({ id: other.connectionId, model: "wts/wts-mini" });
        } finally {
            await other.cleanup();
        }
    });

    it("skips disabled connections and never uses another owner's", async () => {
        const other = await createFixture({
            url: "https://example.test/",
            connection: { kind: "anthropic", model: "anthropic/claude-x" },
        });
        try {
            const owner = { userId: other.userId };
            await other.sql`UPDATE provider_connections SET enabled = FALSE WHERE id = ${other.connectionId}`;
            await expect(
                other.store.resolveConnection({
                    ...owner,
                    connectionId: other.connectionId,
                    model: "anthropic/claude-x",
                }),
            ).rejects.toBeInstanceOf(NoConnectionError);
            // Another owner's connection is never used.
            await expect(
                other.store.resolveConnection({
                    ...owner,
                    connectionId: fx.connectionId,
                    model: "openai/model-a",
                }),
            ).rejects.toBeInstanceOf(NoConnectionError);
        } finally {
            await other.cleanup();
        }
    });

    it("refuses when the account has no virtual key yet", async () => {
        await fx.sql`DELETE FROM virtual_keys WHERE user_id = ${fx.userId}`;
        await expect(
            fx.store.resolveConnection({
                userId: fx.userId,
                connectionId: fx.connectionId,
                model: null,
            }),
        ).rejects.toThrow(/model gateway/);
    });

    it("records, finishes and repairs Macro versions", async () => {
        const monitor = (await fx.store.getMonitor(fx.monitorId))!;
        const before = await fx.sql<
            { version: number }[]
        >`SELECT version FROM macros WHERE monitor_id = ${fx.monitorId} ORDER BY version DESC LIMIT 1`;
        const base = before[0]?.version ?? 0;

        const recording = await fx.store.insertRecording(
            monitor,
            "Open Billing",
        );
        expect(await fx.store.getMacro(recording)).toMatchObject({
            status: "recording",
            source: "agent",
            goal: "Open Billing",
            version: base + 1,
            steps: [],
        });
        await fx.store.finishRecording(recording, {
            status: "draft",
            steps,
            note: "Opens Billing.",
        });
        expect(await fx.store.getMacro(recording)).toMatchObject({
            status: "draft",
            steps,
            note: "Opens Billing.",
        });
        // A finished recording is not overwritten by a late second finish.
        await fx.store.finishRecording(recording, {
            status: "failed",
            steps: [],
            note: "late",
        });
        expect((await fx.store.getMacro(recording))?.status).toBe("draft");

        const activeId = (
            await fx.sql<
                { id: string }[]
            >`SELECT id FROM macros WHERE monitor_id = ${fx.monitorId} AND status = 'active'`
        )[0]!.id;
        const active = (await fx.store.getMacro(activeId))!;
        const repairedId = await fx.store.insertRepair(
            active,
            monitor,
            [steps[1]!],
            "Step 2 'Open Billing': the tab was renamed",
        );
        expect(repairedId).not.toBeNull();
        expect(await fx.store.getMacro(repairedId!)).toMatchObject({
            status: "active",
            source: "repair",
            version: base + 2,
            goal: active.goal,
            steps: [steps[1]],
        });
        expect((await fx.store.getMacro(activeId))?.status).toBe("archived");
        // Repairing a version that is no longer active changes nothing.
        expect(
            await fx.store.insertRepair(active, monitor, steps, "stale"),
        ).toBeNull();
        expect((await fx.store.getMacro(repairedId!))?.status).toBe("active");
    });

    it("numbers and clears a Run's steps", async () => {
        const runId = await fx.addRun();
        const subject = {
            runId,
            macroId: null,
            monitorId: fx.monitorId,
            userId: fx.userId,
        };
        const row = {
            kind: "click",
            title: "Open Billing",
            status: "ok" as const,
            detail: { selector: "css=#x", nested_key: 1 },
            screenshotKey: null,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 12,
        };
        expect(await fx.store.nextSeq(subject)).toBe(0);
        await fx.store.insertRunStep(subject, {
            ...row,
            seq: 0,
            phase: "macro",
        });
        await fx.store.insertRunStep(subject, {
            ...row,
            seq: 1,
            phase: "compare",
            kind: "report",
            inputTokens: 120,
            outputTokens: 30,
        });
        expect(await fx.store.nextSeq(subject)).toBe(2);
        const stored = await fx.sql<
            { detail: string; inputTokens: number }[]
        >`SELECT detail::text AS detail, input_tokens FROM run_steps WHERE run_id = ${runId} ORDER BY seq`;
        expect(JSON.parse(stored[0]!.detail)).toEqual({
            selector: "css=#x",
            nested_key: 1,
        });
        expect(stored[1]!.inputTokens).toBe(120);

        await fx.store.clearRunSteps(runId, ["macro", "repair"]);
        expect(await fx.store.nextSeq(subject)).toBe(2);
        const left =
            await fx.sql`SELECT phase FROM run_steps WHERE run_id = ${runId}`;
        expect(left.map(r => r.phase)).toEqual(["compare"]);
    });

    it("leaves recent recordings alone when failing stale ones", async () => {
        // A cut-off no row can be older than: checks the statement, touches nothing.
        expect(
            await fx.store.failStaleRecordings(50 * 365 * 24 * 3600 * 1000),
        ).toBe(0);
    });
});
