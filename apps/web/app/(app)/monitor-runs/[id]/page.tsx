import { RunPage } from "@/components/monitor/run-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Run" };

/** One Run and its Trace: how the page was checked that time. */
export default async function Page({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return <RunPage id={id} />;
}
