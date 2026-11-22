"use client";

import { providerLabel, providerLogo } from "@/lib/connections/providers";
import { cn } from "@watchthatsite/ui/lib/utils";
import { Globe } from "lucide-react";
import React from "react";

/** A provider's logo, or its initial when there is none (or it fails to load). */
export function ProviderLogo({
    kind,
    baseUrl = null,
    className,
}: {
    kind: string;
    baseUrl?: string | null;
    className?: string;
}) {
    const src = providerLogo(kind, baseUrl);
    const [failed, setFailed] = React.useState(false);
    const box = cn(
        "flex size-5 shrink-0 items-center justify-center rounded",
        className,
    );

    if (baseUrl) {
        return (
            <span className={cn(box, "bg-muted text-muted-foreground")}>
                <Globe className="size-3.5" />
            </span>
        );
    }
    if (!src || failed) {
        return (
            <span
                className={cn(
                    box,
                    "bg-muted text-muted-foreground text-[10px] font-semibold uppercase",
                )}>
                {providerLabel(kind, null).charAt(0)}
            </span>
        );
    }
    return (
        // Logos are small local files; next/image adds nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt=""
            width={20}
            height={20}
            onError={() => setFailed(true)}
            className={cn(
                "size-5 shrink-0 rounded bg-white object-contain p-px",
                className,
            )}
        />
    );
}
