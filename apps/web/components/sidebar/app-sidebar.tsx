"use client";

import * as React from "react";

import { Separator } from "@watchthatsite/ui/components/separator";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@watchthatsite/ui/components/sidebar";
import Link from "next/link";
import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    return (
        <Sidebar variant="inset" {...props}>
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton asChild>
                            <Link href="/home">
                                {/* eslint-disable-next-line @next/next/no-img-element -- static logo */}
                                <img
                                    src="/images/watchthatsite.svg"
                                    alt=""
                                    className="flex aspect-square size-6 items-center justify-center rounded"
                                />
                                <p className="truncate">WatchThatSite</p>
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>
            <SidebarContent>
                <NavMain />
            </SidebarContent>
            <SidebarFooter>
                <Separator />

                <NavUser />
            </SidebarFooter>
        </Sidebar>
    );
}
