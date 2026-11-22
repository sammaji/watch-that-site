import "server-only";

import { AgentError } from "@/lib/agent";
import { visibleMonitor, type VisibleMonitor } from "@/lib/objects";
import { SchedulerError } from "@/lib/scheduler";
import { auth } from "@watchthatsite/auth/server";
import { headers } from "next/headers";

/**
 * The ownership check every server action and route in this area runs first.
 * The Monitor is looked up through PostgREST as the viewer, so row-level
 * security decides: someone else's Monitor comes back as "not found".
 */

export type ActionResult<T> =
    { ok: true; data: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID.test(value);
}

export type Access =
    { ok: true; monitor: VisibleMonitor } | { ok: false; error: string };

/** The Monitor as the signed-in viewer sees it, or why they may not act on it. */
export async function monitorAccess(monitorId: string): Promise<Access> {
    if (!isUuid(monitorId)) return { ok: false, error: "Invalid Monitor id." };
    let token: string | undefined;
    try {
        token = (await auth.api.getToken({ headers: await headers() }))?.token;
    } catch {
        token = undefined;
    }
    if (!token) {
        return { ok: false, error: "You are signed out. Sign in and retry." };
    }
    const monitor = await visibleMonitor(monitorId, token);
    return monitor ?
            { ok: true, monitor }
        :   { ok: false, error: "Monitor not found." };
}

/** An error whose message is written for the owner and safe to show. */
export class OwnerError extends Error {}

/** Turns anything thrown into a line the owner can read. */
export function ownerMessage(error: unknown): string {
    if (
        error instanceof OwnerError ||
        error instanceof SchedulerError ||
        error instanceof AgentError
    ) {
        return error.message;
    }
    console.error("[actions] unexpected failure", error);
    return "Something went wrong on our side. Try again.";
}

/** Runs `fn` for a Monitor the viewer may act on. */
export async function guarded<T>(
    monitorId: string,
    fn: (monitor: VisibleMonitor) => Promise<T>,
): Promise<ActionResult<T>> {
    try {
        const access = await monitorAccess(monitorId);
        if (!access.ok) return access;
        return { ok: true, data: await fn(access.monitor) };
    } catch (error) {
        return { ok: false, error: ownerMessage(error) };
    }
}
