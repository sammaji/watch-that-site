"use client";

import { avatarUrl } from "@/lib/utils";
import { authClient } from "@watchthatsite/auth/client";
import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from "@watchthatsite/ui/components/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@watchthatsite/ui/components/dropdown-menu";
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@watchthatsite/ui/components/sidebar";
import { Skeleton } from "@watchthatsite/ui/components/skeleton";
import { getInitials } from "@watchthatsite/ui/lib/utils";
import {
    ChevronsUpDown,
    LogOut,
    Monitor,
    Moon,
    Palette,
    Sun,
    UserIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import React from "react";

const noopSubscribe = () => () => {};

export function NavUser() {
    const { isMobile } = useSidebar();

    const { data: session, isPending: isSessionLoading } =
        authClient.useSession();

    const initial = React.useMemo(
        () => getInitials(session?.user?.name),
        [session],
    );

    // Radix derives the trigger's id from React's useId, which drifts
    // between the server render and hydration here (the session query
    // resolves differently on each side). Rendering the
    // menu only once hydrated keeps the server HTML and the first client
    // render identical.
    const hydrated = React.useSyncExternalStore(
        noopSubscribe,
        () => true,
        () => false,
    );
    if (!hydrated) {
        return (
            <SidebarMenu>
                <SidebarMenuItem>
                    <SidebarMenuButton size="lg">
                        <Skeleton className="bg-secondary-foreground/20 h-8 w-8 rounded-full" />
                    </SidebarMenuButton>
                </SidebarMenuItem>
            </SidebarMenu>
        );
    }

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
                            {isSessionLoading ?
                                <Skeleton className="bg-secondary-foreground/20 h-8 w-8 rounded-full" />
                            :   <Avatar className="h-8 w-8">
                                    <AvatarImage
                                        src={avatarUrl(session?.user.image)}
                                        alt={session?.user.name}
                                    />
                                    <AvatarFallback>{initial}</AvatarFallback>
                                </Avatar>
                            }

                            <div className="grid flex-1 text-left text-sm leading-tight">
                                {isSessionLoading ?
                                    <Skeleton className="bg-secondary-foreground/20 h-3 w-12" />
                                :   <span className="truncate">
                                        {session?.user.name}
                                    </span>
                                }
                                {isSessionLoading ?
                                    <Skeleton className="bg-secondary-foreground/20 mt-1 h-3 w-full" />
                                :   <span className="text-muted-foreground truncate text-xs">
                                        {session?.user.email}
                                    </span>
                                }
                            </div>
                            <ChevronsUpDown className="ml-auto size-4" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="text-muted-foreground w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                        side={isMobile ? "bottom" : "right"}
                        align="end"
                        sideOffset={4}>
                        <DropdownMenuLabel className="p-0 font-normal">
                            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                                {isSessionLoading ?
                                    <Skeleton className="bg-secondary-foreground/20 h-8 w-8 rounded-full" />
                                :   <Avatar className="h-8 w-8 rounded-lg">
                                        <AvatarImage
                                            src={avatarUrl(session?.user.image)}
                                            alt={session?.user.name}
                                        />
                                        <AvatarFallback className="rounded-lg">
                                            {initial}
                                        </AvatarFallback>
                                    </Avatar>
                                }
                                <div className="grid flex-1 text-left text-sm leading-tight">
                                    {isSessionLoading ?
                                        <Skeleton className="bg-secondary-foreground/20 h-3 w-12" />
                                    :   <span className="truncate">
                                            {session?.user.name}
                                        </span>
                                    }
                                    {isSessionLoading ?
                                        <Skeleton className="bg-secondary-foreground/20 mt-1 h-3 w-full" />
                                    :   <span className="text-muted-foreground truncate text-xs">
                                            {session?.user.email}
                                        </span>
                                    }
                                </div>
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />

                        <DropdownMenuGroup>
                            <DropdownMenuItem
                                className="cursor-pointer"
                                asChild>
                                <Link href="/accounts">
                                    <UserIcon className="size-4" />
                                    <span className="flex-1 truncate">
                                        Your account
                                    </span>
                                </Link>
                            </DropdownMenuItem>
                            <ThemeMenu />
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" asChild>
                            <Link href="/logout">
                                <LogOut />
                                Log out
                            </Link>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

const THEMES = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
] as const;

/** How WatchThatSite looks on this device: light, dark, or the system's choice. */
function ThemeMenu() {
    const { theme, setTheme } = useTheme();
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger className="cursor-pointer">
                <Palette className="size-4" />
                Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                    value={theme ?? "system"}
                    onValueChange={setTheme}>
                    {THEMES.map(t => (
                        <DropdownMenuRadioItem
                            key={t.value}
                            value={t.value}
                            className="cursor-pointer">
                            <t.icon className="size-4" />
                            {t.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
