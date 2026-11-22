"use client";

import { formatDateTime } from "@/components/monitor/format";
import type { Macro, MacroStatus } from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import { ChevronDown } from "lucide-react";
import React from "react";
import { SOURCE_LABEL } from "./step-format";
import { StepList } from "./step-list";

const STATUS_LABEL: Record<MacroStatus, string> = {
    active: "In use",
    archived: "Earlier version",
    draft: "Waiting for approval",
    recording: "Being recorded",
    failed: "Recording failed",
};

/** Every version of the Macro, newest first, with who made it and why. */
export function VersionHistory({ versions }: { versions: Macro[] }) {
    const [open, setOpen] = React.useState<string | null>(null);
    if (versions.length === 0) return null;
    return (
        <section aria-labelledby="versions-heading" className="space-y-3">
            <h3 id="versions-heading" className="text-base font-medium">
                Version history
            </h3>
            <ul className="divide-y rounded-lg border">
                {versions.map(version => {
                    const expanded = open === version.id;
                    return (
                        <li key={version.id} data-testid="macro-version">
                            <button
                                type="button"
                                aria-expanded={expanded}
                                onClick={() =>
                                    setOpen(expanded ? null : version.id)
                                }
                                className="hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset">
                                <span className="text-muted-foreground w-8 shrink-0 pt-0.5 text-sm tabular-nums">
                                    v{version.version}
                                </span>
                                <span className="min-w-0 flex-1 space-y-1">
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        <span className="text-sm">
                                            {SOURCE_LABEL[version.source]}
                                        </span>
                                        <Badge
                                            variant={
                                                version.status === "active" ?
                                                    "default"
                                                : version.status === "failed" ?
                                                    "destructive"
                                                :   "secondary"
                                            }>
                                            {STATUS_LABEL[version.status]}
                                        </Badge>
                                    </span>
                                    {version.note ?
                                        <span className="text-muted-foreground block text-xs break-words">
                                            {version.note}
                                        </span>
                                    :   null}
                                    <span className="text-muted-foreground block text-xs">
                                        {version.steps.length} step
                                        {version.steps.length === 1 ?
                                            ""
                                        :   "s"}{" "}
                                        · {formatDateTime(version.created_at)}
                                    </span>
                                </span>
                                <ChevronDown
                                    className={
                                        expanded ?
                                            "text-muted-foreground mt-1 size-4 shrink-0 rotate-180 transition-transform"
                                        :   "text-muted-foreground mt-1 size-4 shrink-0 transition-transform"
                                    }
                                />
                            </button>
                            {expanded ?
                                <div className="space-y-2 px-3 pb-3">
                                    {version.goal ?
                                        <p className="text-muted-foreground text-xs">
                                            Goal: {version.goal}
                                        </p>
                                    :   null}
                                    <StepList steps={version.steps} />
                                </div>
                            :   null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
