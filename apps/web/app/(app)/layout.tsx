import { ConnectionNudge } from "@/components/settings/connections/connection-nudge";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { ensurePlatformConnection, getUserId } from "@/lib/connections/service";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@watchthatsite/ui/components/sidebar";

export default async function AppLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // Every account gets its WatchThatSite credit the first time it signs in.
    // Without the model gateway the app still renders, and the next page
    // load tries again.
    const userId = await getUserId().catch(() => null);
    if (userId) {
        await ensurePlatformConnection(userId).catch(error =>
            console.error(
                "[connections] could not set up the platform credit:",
                error instanceof Error ? error.message : "unknown error",
            ),
        );
    }
    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="overflow-hidden border">
                <header className="flex h-[48px] shrink-0 items-center gap-2 border-b">
                    <div className="flex w-full items-center gap-2 px-4">
                        <SidebarTrigger className="-ml-1" />
                        <span className="bg-border mr-2 h-4 w-px"></span>
                    </div>
                </header>
                <ConnectionNudge />
                <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
            </SidebarInset>
        </SidebarProvider>
    );
}
