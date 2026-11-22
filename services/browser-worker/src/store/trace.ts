import type { Logger } from "pino";
import type { RunStepInput, StepSubject, Store } from "./store.js";

export type TraceStep = Omit<RunStepInput, "seq"> & { seq?: number };

/**
 * Writes the run_steps rows of one Run or one recording, in order.
 *
 * The trace is for people to read; it never decides anything. A row that
 * cannot be written is logged and dropped, so a database hiccup cannot fail
 * a Capture or an agent job.
 */
export class Trace {
    private constructor(
        private readonly store: Store,
        readonly subject: StepSubject,
        private readonly logger: Logger,
        private next: number,
    ) {}

    /** Continues after the rows the subject already has. */
    static async open(
        store: Store,
        subject: StepSubject,
        logger: Logger,
    ): Promise<Trace> {
        let next = 0;
        try {
            next = await store.nextSeq(subject);
        } catch (err) {
            logger.warn({ err }, "[trace] could not read the next step number");
        }
        return new Trace(store, subject, logger, next);
    }

    /** The id of the Run or recording, which step screenshots are filed under. */
    get subjectId(): string {
        return this.subject.runId ?? this.subject.macroId;
    }

    /** Takes the next `seq` now, for a row whose outcome is known only later. */
    reserve(): number {
        return this.next++;
    }

    async write(step: TraceStep): Promise<void> {
        const seq = step.seq ?? this.reserve();
        try {
            await this.store.insertRunStep(this.subject, { ...step, seq });
        } catch (err) {
            this.logger.warn(
                { err, seq, phase: step.phase },
                "[trace] could not write a step",
            );
        }
    }
}
