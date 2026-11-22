"use client";

import type { Usage, UsagePeriod } from "@/lib/usage";
import { useQuery } from "@tanstack/react-query";

export type { Usage, UsagePeriod };

/** The account's usage over a period, refreshed every minute while open. */
export function useUsage(period: UsagePeriod) {
    return useQuery<Usage>({
        queryKey: ["usage", period],
        queryFn: async () => {
            const res = await fetch(`/api/usage?period=${period}`, {
                cache: "no-store",
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as {
                    error?: string;
                } | null;
                throw new Error(body?.error ?? "Usage could not be loaded.");
            }
            return (await res.json()) as Usage;
        },
        refetchInterval: 60_000,
        placeholderData: previous => previous,
    });
}
