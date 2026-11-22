import { ChangeView } from "@/components/change/change-view";
import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Change" };

/**
 * The Change view: one URL per Change, linked from every notification.
 * `?feedback=noise` opens "Ignore changes like this" on load.
 */
export default async function ChangePage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return (
        <Suspense fallback={null}>
            <ChangeView key={id} id={id} />
        </Suspense>
    );
}
