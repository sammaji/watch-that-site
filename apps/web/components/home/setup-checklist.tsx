"use client";

import { useConnections } from "@/hooks/use-connections";
import { useMonitors } from "@/hooks/use-monitors";
import { listNotificationConfigs } from "@/lib/notifications";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "@watchthatsite/auth/client";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@watchthatsite/ui/components/collapsible";
import { cn } from "@watchthatsite/ui/lib/utils";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";

type Item = {
    label: string;
    href: string;
    done: boolean;
    optional?: boolean;
};

/**
 * The first things to set up, ticked off as they get done. Gone once both
 * required items are: a notification provider and a Monitor.
 */
export function SetupChecklist() {
    const { data: session } = authClient.useSession();
    const userId = session?.user.id;
    const monitors = useMonitors({ pageSize: 1 });
    const connections = useConnections();
    const configs = useQuery({
        queryKey: ["notification-configs", userId],
        queryFn: () => listNotificationConfigs({ userId: userId! }),
        enabled: !!userId,
    });

    if (monitors.isLoading || connections.isLoading || configs.isLoading) {
        return null;
    }

    const items: Item[] = [
        {
            label: "Configure a notification provider",
            href: "/notifications",
            done: (configs.data ?? []).some(c => c.enabled),
        },
        {
            label: "Create a monitor",
            href: "/monitors/create",
            done: monitors.count > 0,
        },
        {
            label: "Connect your AI provider",
            href: "/settings/connections",
            done: (connections.data ?? []).some(c => !c.managed),
            optional: true,
        },
    ];
    if (items.every(i => i.done || i.optional)) return null;
    const done = items.filter(i => i.done).length;

    return (
        <Collapsible
            defaultOpen
            className="group rounded-lg border border-amber-500/40 bg-amber-500/10 dark:border-amber-400/30 dark:bg-amber-400/10">
            <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-amber-500/10">
                <h2 className="flex-1 text-base font-medium">
                    Setup checklist
                </h2>
                <span className="text-xs text-amber-900/70 tabular-nums dark:text-amber-200/70">
                    {done} of {items.length} done
                </span>
                <ChevronDown className="size-4 shrink-0 text-amber-900/60 transition-transform group-data-[state=open]:rotate-180 dark:text-amber-200/60" />
            </CollapsibleTrigger>
            <CollapsibleContent>
                <ul className="space-y-1 px-2 pb-3">
                    {items.map(item => (
                        <li key={item.label}>
                            <Link
                                href={item.href}
                                data-testid="setup-item"
                                data-done={item.done}
                                className="group/item flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-amber-500/10">
                                <span
                                    role="checkbox"
                                    aria-checked={item.done}
                                    aria-label={item.label}
                                    className={cn(
                                        "flex size-4 shrink-0 items-center justify-center rounded border",
                                        item.done ?
                                            "bg-primary border-primary text-primary-foreground"
                                        :   "bg-background border-amber-700/40 dark:border-amber-200/40",
                                    )}>
                                    {item.done ?
                                        <Check
                                            className="size-3"
                                            strokeWidth={3}
                                        />
                                    :   null}
                                </span>
                                <span
                                    className={cn(
                                        "min-w-0 flex-1",
                                        item.done &&
                                            "text-muted-foreground line-through",
                                    )}>
                                    {item.optional ?
                                        <span className="text-muted-foreground">
                                            (Optional){" "}
                                        </span>
                                    :   null}
                                    {item.label}
                                </span>
                                {item.done ? null : (
                                    <ChevronRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100" />
                                )}
                            </Link>
                        </li>
                    ))}
                </ul>
            </CollapsibleContent>
        </Collapsible>
    );
}
