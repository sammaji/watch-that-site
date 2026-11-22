"use client";

import { MonitorForm } from "@/components/monitor/monitor-form";
import { useMonitor } from "@/hooks/use-monitors";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

export default function EditMonitorPage() {
    const params = useParams<{ id: string }>();
    const { monitor, isLoading, error } = useMonitor(params.id);

    if (isLoading) {
        return (
            <div className="text-muted-foreground flex h-64 items-center justify-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin" />
                Loading the Monitor…
            </div>
        );
    }

    if (error || !monitor) {
        return (
            <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-3 text-sm">
                {error?.message ?? "Monitor not found."}
                <Link href="/monitors" className="underline underline-offset-2">
                    All Monitors
                </Link>
            </div>
        );
    }

    return <MonitorForm key={monitor.id} monitor={monitor} />;
}
