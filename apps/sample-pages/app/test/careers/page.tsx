import { CAREERS_WINDOW_MS, openRoles } from "@/lib/careers";
import {
    testCareersPageParams,
    toPositiveInterval,
    type SearchParams,
} from "@/lib/refresh-params";
import type { Metadata } from "next";
import { CareersBoard } from "./careers-board";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Careers at Northwind" };

/**
 * A careers page whose product manager roles rotate every 30 seconds, or
 * every `?refresh_interval=<ms>` (see lib/careers.ts), with a department
 * select that filters on the client. The "Try an example" Monitor in the app
 * watches it for new PM roles.
 */
export default async function CareersPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const { refreshInterval } = await testCareersPageParams(searchParams);
    const windowMs = toPositiveInterval(refreshInterval, CAREERS_WINDOW_MS);
    // eslint-disable-next-line react-hooks/purity -- the roles follow the clock by design
    const roles = openRoles(Date.now(), windowMs);
    return <CareersBoard roles={roles} />;
}
