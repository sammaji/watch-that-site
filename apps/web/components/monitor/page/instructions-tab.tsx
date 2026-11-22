"use client";

import type { Monitor } from "@/hooks/use-monitors";
import { DEFAULT_INSTRUCTIONS } from "@watchthatsite/types";
import Link from "next/link";

/**
 * The Instructions tab: what the owner asked to be told about. Without any,
 * the default applies and is shown. They are changed with the page's Edit.
 */
export function InstructionsTab({ monitor }: { monitor: Monitor }) {
    const instructions = monitor.instructions?.trim() ?? "";
    return (
        <section aria-labelledby="instructions-heading" className="space-y-3">
            <h2 id="instructions-heading" className="text-lg font-medium">
                Instructions
            </h2>
            {instructions ?
                <p
                    data-testid="instructions"
                    className="text-sm leading-6 break-words whitespace-pre-wrap">
                    {instructions}
                </p>
            :   <p
                    data-testid="instructions"
                    className="text-muted-foreground text-sm leading-6">
                    None written, so the default applies: “
                    {DEFAULT_INSTRUCTIONS}”{" "}
                    <Link
                        href={`/monitors/edit/${monitor.id}`}
                        className="text-foreground underline underline-offset-2">
                        Write your own
                    </Link>
                </p>
            }
        </section>
    );
}
