import {
    stepScreenshotKey,
    type MacroStep,
    type TestMacroResponse,
} from "@watchthatsite/types";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BlockerProvider } from "../lib/blocking.js";
import type { BrowserPool } from "../lib/browser-pool.js";
import type { MonitorRow, Store } from "../store/store.js";
import type { ObjectStore } from "../types.js";
import { createPlayer, playMacro } from "./player.js";
import { uploadStepScreenshot } from "./screenshot.js";
import { openMonitorPage } from "./session.js";

/**
 * Replays `steps` once in a fresh browser with the Monitor's secrets and no
 * model, so the owner can check a Macro they edited. The screenshot shows the
 * page after the last step that ran.
 */
export async function testMacro(
    deps: {
        store: Store;
        pool: BrowserPool;
        blockers: BlockerProvider;
        objectStore: ObjectStore | null;
        logger: Logger;
    },
    monitor: MonitorRow,
    steps: MacroStep[],
): Promise<TestMacroResponse> {
    const log = deps.logger.child({ monitorId: monitor.id });
    const live = await openMonitorPage({ ...deps, logger: log }, monitor);
    try {
        const player = createPlayer(
            live.page,
            name => deps.store.readSecret(monitor.id, name),
            { tracker: live.tracker },
        );
        const replay = await playMacro(player, steps);
        // Filed like a step screenshot, under an id of its own: a test is
        // neither a Run nor a recording.
        const screenshotKey = await uploadStepScreenshot(
            live.page,
            deps.objectStore,
            stepScreenshotKey(
                monitor.id,
                randomUUID(),
                Math.max(0, replay.steps.length - 1),
            ),
            player.sensitive,
            log,
        );
        return {
            ok: replay.ok,
            failed_step: replay.failedStep,
            error: replay.error,
            steps: replay.steps.map(s => ({
                status: s.status,
                selector: s.selector,
                error: s.error,
                duration_ms: s.durationMs,
            })),
            screenshot_key: screenshotKey,
        };
    } finally {
        await live.close();
    }
}
