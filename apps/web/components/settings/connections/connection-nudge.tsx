"use client";

import { isUsable, useConnections } from "@/hooks/use-connections";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatUsd } from "./meta";

const CONNECTIONS_PATH = "/settings/connections";

/** Credit below this many dollars earns a note. */
const LOW_CREDIT_USD = 1;

/**
 * A slim banner across the app when no connection can run a Monitor (the
 * credit is used up and there is no own key), and a quieter note while the
 * credit is running low and the account has no key of its own.
 */
export function ConnectionNudge() {
    const pathname = usePathname();
    const { data: connections, credit, isLoading, error } = useConnections();

    // Shown only once the list is known, never while loading or failing.
    if (isLoading || error || !connections) return null;
    if (pathname.startsWith(CONNECTIONS_PATH)) return null;

    const usable = connections.filter(c => isUsable(c, credit));
    if (usable.length === 0) {
        return (
            <div
                role="status"
                className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b bg-amber-500/10 px-4 py-1.5 text-center text-sm">
                <span>
                    {credit && credit.left_usd <= 0 ?
                        "Your WatchThatSite credit is used up. Add your own model connection to keep checking pages."
                    :   "Add a model connection to start checking pages."}
                </span>
                <Link
                    href={CONNECTIONS_PATH}
                    className="font-medium underline underline-offset-4">
                    Add a connection
                </Link>
            </div>
        );
    }

    const onlyCredit = usable.every(c => c.managed);
    if (onlyCredit && credit && credit.left_usd < LOW_CREDIT_USD) {
        return (
            <div
                role="status"
                className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 border-b px-4 py-1 text-center text-xs">
                <Link
                    href="/usage"
                    className="underline-offset-4 hover:underline">
                    {formatUsd(credit.left_usd)} of WatchThatSite credit left.
                </Link>
                <Link
                    href={CONNECTIONS_PATH}
                    className="underline underline-offset-4">
                    Add your own key
                </Link>
            </div>
        );
    }
    return null;
}
