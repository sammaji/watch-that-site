/**
 * Open roles for the careers fixture (`/test/careers`): a pure function of
 * the clock, like lib/live-prices.ts. Time is cut into windows of 30 seconds
 * by default (`?refresh_interval=<ms>` changes it).
 * The engineering, design and sales roles never change; the product manager
 * roles slide through a fixed pool, two at a time, so every new window posts
 * one new product manager role and retires the oldest. Nothing is stored, so
 * every server (Vercel's included) gives the same answer for the same moment.
 */

export const CAREERS_WINDOW_MS = 30_000;

export type Department = "Engineering" | "Product" | "Design" | "Sales";
export const DEPARTMENTS: Department[] = [
    "Engineering",
    "Product",
    "Design",
    "Sales",
];

export type Role = {
    id: string;
    title: string;
    department: Department;
    location: string;
    type: "Full-time" | "Contract";
};

const STANDING: Role[] = [
    {
        id: "eng-backend",
        title: "Senior Backend Engineer",
        department: "Engineering",
        location: "Remote, Europe",
        type: "Full-time",
    },
    {
        id: "eng-frontend",
        title: "Frontend Engineer",
        department: "Engineering",
        location: "Berlin",
        type: "Full-time",
    },
    {
        id: "eng-sre",
        title: "Site Reliability Engineer",
        department: "Engineering",
        location: "Remote, Americas",
        type: "Full-time",
    },
    {
        id: "des-product",
        title: "Product Designer",
        department: "Design",
        location: "London",
        type: "Full-time",
    },
    {
        id: "des-brand",
        title: "Brand Designer",
        department: "Design",
        location: "Remote",
        type: "Contract",
    },
    {
        id: "sales-ae",
        title: "Account Executive, Mid-Market",
        department: "Sales",
        location: "New York",
        type: "Full-time",
    },
    {
        id: "sales-se",
        title: "Solutions Engineer",
        department: "Sales",
        location: "Remote, Americas",
        type: "Full-time",
    },
];

const PRODUCT_POOL: Role[] = [
    {
        id: "pm-growth",
        title: "Product Manager, Growth",
        department: "Product",
        location: "Remote, Europe",
        type: "Full-time",
    },
    {
        id: "pm-platform",
        title: "Senior Product Manager, Platform",
        department: "Product",
        location: "Berlin",
        type: "Full-time",
    },
    {
        id: "pm-billing",
        title: "Product Manager, Billing",
        department: "Product",
        location: "New York",
        type: "Full-time",
    },
    {
        id: "pm-ai",
        title: "Product Manager, AI Assistant",
        department: "Product",
        location: "Remote",
        type: "Full-time",
    },
    {
        id: "pm-mobile",
        title: "Product Manager, Mobile",
        department: "Product",
        location: "London",
        type: "Full-time",
    },
    {
        id: "pm-data",
        title: "Group Product Manager, Data",
        department: "Product",
        location: "Remote, Americas",
        type: "Full-time",
    },
    {
        id: "pm-integrations",
        title: "Product Manager, Integrations",
        department: "Product",
        location: "Amsterdam",
        type: "Full-time",
    },
];

/** The window a moment falls in: whole windows since the epoch. */
export function careersWindow(
    nowMs: number,
    windowMs = CAREERS_WINDOW_MS,
): number {
    return Math.floor(nowMs / windowMs);
}

/** The roles open at `nowMs`, newest first within each department. */
export function openRoles(nowMs: number, windowMs = CAREERS_WINDOW_MS): Role[] {
    const w = careersWindow(nowMs, windowMs);
    const n = PRODUCT_POOL.length;
    // The newer of the two is the one this window posted.
    const product = [PRODUCT_POOL[(w + 1) % n]!, PRODUCT_POOL[w % n]!];
    return [...STANDING.slice(0, 3), ...product, ...STANDING.slice(3)];
}
