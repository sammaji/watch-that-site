import { MonitorPage } from "@/components/monitor/page/monitor-page";
import { Suspense } from "react";

export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    // MonitorPage reads ?tab= and ?snooze= through useSearchParams.
    return (
        <Suspense>
            <MonitorPage id={id} />
        </Suspense>
    );
}
