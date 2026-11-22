"use client";

import {
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@watchthatsite/ui/components/sidebar";
import { cn } from "@watchthatsite/ui/lib/utils";
import {
    Activity,
    ArrowBigUp,
    ArrowUpRight,
    Bell,
    BellPlus,
    ChartColumn,
    Home,
    Plug,
    UserCircle,
    type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";

interface NavMainItem {
    group_title?: string;
    items: {
        title: string;
        url: string;
        icon?: LucideIcon;
        shortcutKey?: string;
    }[];
}

export const navs: NavMainItem[] = [
    {
        items: [
            {
                title: "Home",
                url: "/home",
                icon: Home,
            },
            {
                title: "Monitors",
                url: "/monitors",
                icon: Activity,
            },
            {
                title: "Monitor runs",
                url: "/monitor-runs",
                icon: BellPlus,
            },
            {
                title: "Notifications",
                url: "/notifications",
                icon: Bell,
            },
        ],
    },
    {
        group_title: "Settings",
        items: [
            {
                title: "BYOK",
                url: "/settings/connections",
                icon: Plug,
            },
            {
                title: "Usage",
                url: "/usage",
                icon: ChartColumn,
            },
            {
                title: "Your account",
                url: "/accounts",
                icon: UserCircle,
            },
        ],
    },
];

export function NavMain() {
    const pathname = usePathname();
    // The longest matching entry wins, so "Appearance" is not also lit on
    // /settings/connections.
    const activeUrl = navs
        .flatMap(group => group.items.map(item => item.url))
        .filter(url => pathname.startsWith(url))
        .sort((a, b) => b.length - a.length)[0];

    return (
        <React.Fragment>
            {navs.map((x, i) => (
                <React.Fragment key={i}>
                    <SidebarGroup>
                        {x.group_title && (
                            <SidebarGroupLabel>
                                {x.group_title}
                            </SidebarGroupLabel>
                        )}
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {x.items.map((item, i) => {
                                    const isActive = item.url === activeUrl;
                                    return (
                                        <SidebarMenuItem key={i}>
                                            <SidebarMenuButton
                                                size="sm"
                                                className={cn({
                                                    "bg-accent hover:bg-accent":
                                                        isActive,
                                                })}
                                                asChild>
                                                <Link href={item.url}>
                                                    {item.icon && (
                                                        <item.icon className="size-4" />
                                                    )}
                                                    {item.title}
                                                    {(item.title === "Help" ||
                                                        item.title ===
                                                            "Shortcuts") && (
                                                        <ArrowUpRight className="size-4" />
                                                    )}
                                                    {item.shortcutKey && (
                                                        <kbd
                                                            className={cn(
                                                                "bg-muted text-muted-foreground pointer-events-none relative ml-auto inline-flex items-center justify-center rounded px-[0.3rem] py-0 font-mono text-xs brightness-125 select-none",
                                                                {
                                                                    "bg-accent":
                                                                        isActive,
                                                                },
                                                            )}>
                                                            <ArrowBigUp className="size-3" />
                                                            {item.shortcutKey}
                                                        </kbd>
                                                    )}
                                                </Link>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    );
                                })}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </React.Fragment>
            ))}
        </React.Fragment>
    );
}
