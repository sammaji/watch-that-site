"use client";

import { SetupChecklist } from "@/components/home/setup-checklist";
import { ChangeCard } from "@/components/monitor/page/changes-list";
import {
    useFailingMonitors,
    useRecentChanges,
} from "@/hooks/use-monitor-changes";
import { useMonitors } from "@/hooks/use-monitors";
import { authClient } from "@watchthatsite/auth/client";
import { Button } from "@watchthatsite/ui/components/button";
import { CircleAlert, Plus } from "lucide-react";
import Link from "next/link";

/** Home: what changed lately, and which Monitors need attention. */
export default function HomePage() {
    const { data: session } = authClient.useSession();
    const monitors = useMonitors({ pageSize: 1 });
    const recent = useRecentChanges(8);
    const failing = useFailingMonitors();
    const name = session?.user.name?.split(" ")[0];

    return (
        <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 p-4 py-6 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                    <h1 className="text-2xl font-semibold tracking-tight break-words">
                        {name ? `Welcome back, ${name}` : "Welcome back"}
                    </h1>
                    <p className="text-muted-foreground text-sm">
                        {monitors.isLoading ?
                            " "
                        : monitors.count === 0 ?
                            "You are not watching any page yet."
                        :   `You are watching ${monitors.count} page${monitors.count === 1 ? "" : "s"}.`
                        }
                    </p>
                </div>
                <Button asChild className="self-start sm:self-auto">
                    <Link href="/monitors/create">
                        <Plus />
                        New Monitor
                    </Link>
                </Button>
            </div>

            <SetupChecklist />

            {failing.monitors.length ?
                <section
                    aria-labelledby="failing-heading"
                    className="space-y-3">
                    <h2
                        id="failing-heading"
                        className="flex items-center gap-2 text-lg font-medium">
                        <CircleAlert className="text-destructive size-4" />
                        Monitors that are failing
                    </h2>
                    <ul className="border-destructive/30 divide-y rounded-lg border">
                        {failing.monitors.map(item => (
                            <li key={item.monitor_id}>
                                <Link
                                    href={`/monitors/${item.monitor_id}`}
                                    data-testid="failing-monitor"
                                    className="hover:bg-muted/40 block min-w-0 space-y-0.5 px-3 py-2.5">
                                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                                        <span className="min-w-0 break-words">
                                            {item.monitor?.name ?? "Monitor"}
                                        </span>
                                        <span className="text-destructive text-xs font-normal">
                                            {item.consecutive_failures} Run
                                            {item.consecutive_failures === 1 ?
                                                ""
                                            :   "s"}{" "}
                                            failed in a row
                                        </span>
                                    </p>
                                    {item.reason ?
                                        <p className="text-muted-foreground line-clamp-2 text-xs break-words">
                                            {item.reason}
                                        </p>
                                    :   null}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            :   null}

            <section aria-labelledby="recent-heading" className="space-y-3">
                <h2 id="recent-heading" className="text-lg font-medium">
                    Recent Changes
                </h2>
                {recent.error ?
                    <p role="alert" className="text-destructive text-sm">
                        The Changes could not be loaded: {recent.error.message}
                    </p>
                : recent.isLoading ?
                    <p className="text-muted-foreground py-8 text-center text-sm">
                        Loading Changes…
                    </p>
                : recent.changes.length === 0 ?
                    <p className="text-muted-foreground rounded-md border border-dashed px-4 py-10 text-center text-sm">
                        {monitors.count === 0 ?
                            "Create a Monitor, say what you want to be told about, and Changes will show up here."
                        :   "Nothing to report yet. Your Monitors are watching; quiet Runs are listed on each Monitor's timeline."
                        }
                    </p>
                :   <ul className="space-y-2">
                        {recent.changes.map(change => (
                            <li key={change.id}>
                                <ChangeCard
                                    change={change}
                                    monitorName={change.monitor?.name}
                                />
                            </li>
                        ))}
                    </ul>
                }
            </section>
        </main>
    );
}
