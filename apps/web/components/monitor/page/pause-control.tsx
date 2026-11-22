"use client";

import { usePatchMonitor, type Monitor } from "@/hooks/use-monitors";
import { replaceQuery } from "@/lib/url";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@watchthatsite/ui/components/alert-dialog";
import { Button } from "@watchthatsite/ui/components/button";
import { Pause, Play } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import React from "react";
import { toast } from "sonner";

/**
 * Pause / Resume (`monitors.status`). A paused Monitor is not checked on its
 * schedule; Run now still works. Notifications link here with `?pause=1`,
 * which asks first: mail scanners open links, and a link alone must never
 * pause anything. Any old snooze is cleared along the way.
 */
export function PauseControl({ monitor }: { monitor: Monitor }) {
    const patch = usePatchMonitor();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const paused = monitor.status === "paused";
    const [asking, setAsking] = React.useState(
        searchParams.get("pause") === "1" && !paused,
    );

    async function setPaused(next: boolean) {
        try {
            await patch.mutateAsync({
                id: monitor.id,
                patch: {
                    status: next ? "paused" : "active",
                    snoozed_until: null,
                },
            });
            toast.success(next ? "Monitor paused." : "Monitor resumed.");
        } catch (err) {
            toast.error(
                err instanceof Error ?
                    `That did not save: ${err.message}`
                :   "That did not save. Try again.",
            );
        }
    }

    function closeRequest() {
        setAsking(false);
        replaceQuery(pathname, params => params.delete("pause"));
    }

    return (
        <>
            <Button
                variant="outline"
                data-testid="pause"
                isLoading={patch.isPending}
                onClick={() => void setPaused(!paused)}>
                {paused ?
                    <Play className="size-4" />
                :   <Pause className="size-4" />}
                {paused ? "Resume" : "Pause"}
            </Button>

            <AlertDialog
                open={asking}
                onOpenChange={open => {
                    if (!open) closeRequest();
                }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Pause {monitor.name}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            It stops checking the page until you resume it.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep checking</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                void setPaused(true);
                                closeRequest();
                            }}>
                            Pause
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
