/**
 * An in-memory Store for tests that replay Macros without Postgres. It keeps
 * what was written so tests can read the trace back.
 */
import type { MacroStep, RunStepPhase } from "@watchthatsite/types";
import { randomUUID } from "node:crypto";
import {
    NoConnectionError,
    type MacroRow,
    type MonitorRow,
    type Owner,
    type ResolvedConnection,
    type RunStepInput,
    type StepSubject,
    type Store,
} from "../store/store.js";

export class FakeStore implements Store {
    readonly monitors = new Map<string, MonitorRow>();
    readonly macros = new Map<string, MacroRow>();
    readonly secrets = new Map<string, Map<string, string>>();
    readonly steps: (RunStepInput & { subject: StepSubject })[] = [];
    connection: ResolvedConnection | null = null;

    addMonitor(
        id: string,
        url: string,
        overrides: Partial<MonitorRow> = {},
    ): MonitorRow {
        const monitor: MonitorRow = {
            id,
            userId: "user-1",
            name: "Test Monitor",
            url,
            instructions: "",
            connectionId: null,
            model: null,
            viewportW: 800,
            viewportH: 600,
            blockAds: false,
            extraWaitMs: 0,
            ...overrides,
        };
        this.monitors.set(id, monitor);
        return monitor;
    }

    addMacro(
        monitorId: string,
        steps: MacroStep[],
        goal = "Test goal",
    ): MacroRow {
        const macro: MacroRow = {
            id: randomUUID(),
            monitorId,
            version:
                [...this.macros.values()].filter(m => m.monitorId === monitorId)
                    .length + 1,
            status: "active",
            source: "user",
            goal,
            steps,
            note: "",
        };
        this.macros.set(macro.id, macro);
        return macro;
    }

    setSecret(monitorId: string, name: string, value: string): void {
        const own = this.secrets.get(monitorId) ?? new Map<string, string>();
        own.set(name, value);
        this.secrets.set(monitorId, own);
    }

    async getMonitor(id: string) {
        return this.monitors.get(id) ?? null;
    }
    async getMacro(id: string) {
        return this.macros.get(id) ?? null;
    }
    async secretNames(monitorId: string) {
        return [...(this.secrets.get(monitorId)?.keys() ?? [])].sort();
    }
    async readSecret(monitorId: string, name: string) {
        return this.secrets.get(monitorId)?.get(name) ?? null;
    }
    async utilityModel(): Promise<{
        connectionId: string | null;
        model: string | null;
    }> {
        return { connectionId: null, model: null };
    }

    async resolveConnection(): Promise<ResolvedConnection> {
        if (!this.connection) throw new NoConnectionError();
        return this.connection;
    }
    async insertRecording(monitor: MonitorRow, goal: string) {
        const macro = this.addMacro(monitor.id, [], goal);
        macro.status = "recording";
        macro.source = "agent";
        return macro.id;
    }
    async finishRecording(
        macroId: string,
        outcome: {
            status: "draft" | "failed";
            steps: MacroStep[];
            note: string;
        },
    ) {
        const macro = this.macros.get(macroId);
        if (macro?.status === "recording") Object.assign(macro, outcome);
    }
    async insertRepair(
        old: MacroRow,
        _owner: Owner,
        steps: MacroStep[],
        note: string,
    ) {
        const current = this.macros.get(old.id);
        if (!current || current.status !== "active") return null;
        current.status = "archived";
        const repaired = this.addMacro(old.monitorId, steps, old.goal);
        repaired.source = "repair";
        repaired.note = note;
        return repaired.id;
    }
    async failStaleRecordings() {
        return 0;
    }
    async nextSeq(subject: StepSubject) {
        const id = subject.runId ?? subject.macroId;
        const own = this.steps.filter(
            s => (s.subject.runId ?? s.subject.macroId) === id,
        );
        return own.length === 0 ? 0 : Math.max(...own.map(s => s.seq)) + 1;
    }
    async clearRunSteps(runId: string, phases: RunStepPhase[]) {
        for (let i = this.steps.length - 1; i >= 0; i--) {
            const s = this.steps[i]!;
            if (s.subject.runId === runId && phases.includes(s.phase))
                this.steps.splice(i, 1);
        }
    }
    async insertRunStep(subject: StepSubject, step: RunStepInput) {
        this.steps.push({ ...step, subject });
    }

    /** The rows of one Run or recording, in order. */
    trace(subjectId: string) {
        return this.steps
            .filter(s => (s.subject.runId ?? s.subject.macroId) === subjectId)
            .sort((a, b) => a.seq - b.seq);
    }
}
