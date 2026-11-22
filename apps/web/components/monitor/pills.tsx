import type {
    ChangeStatus,
    MacroOutcome,
    RunVerdict,
} from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import { cn } from "@watchthatsite/ui/lib/utils";
import { MACRO_STATUS_LABEL, VERDICT_LABEL } from "./format";

const AMBER =
    "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300";

/** Change / Not reported / Waiting to confirm. */
export function ChangeStatusPill({
    status,
    className,
}: {
    status: ChangeStatus;
    className?: string;
}) {
    if (status === "change") {
        return (
            <Badge className={className} data-status={status}>
                Change
            </Badge>
        );
    }
    if (status === "pending") {
        return (
            <Badge
                variant="outline"
                className={cn(AMBER, className)}
                data-status={status}>
                Waiting to confirm
            </Badge>
        );
    }
    return (
        <Badge variant="secondary" className={className} data-status={status}>
            Not reported
        </Badge>
    );
}

/** The outcome of a Run: its verdict, or that it is running or failed. */
export function RunOutcomePill({
    status,
    verdict,
    className,
}: {
    status: "pending" | "processing" | "succeeded" | "failed";
    verdict: RunVerdict | null;
    className?: string;
}) {
    if (status === "failed") {
        return (
            <Badge variant="destructive" className={className}>
                Failed
            </Badge>
        );
    }
    if (status !== "succeeded") {
        return (
            <Badge variant="outline" className={cn("animate-pulse", className)}>
                {status === "pending" ? "Queued" : "Running"}
            </Badge>
        );
    }
    if (verdict === "change" || verdict === "pending" || verdict === "noise") {
        return <ChangeStatusPill status={verdict} className={className} />;
    }
    return (
        <Badge
            variant="outline"
            className={cn("text-muted-foreground", className)}>
            {verdict ? VERDICT_LABEL[verdict] : "Done"}
        </Badge>
    );
}

/** How the Macro replay went on a Run. Nothing is shown for a plain "ok". */
export function MacroStatusPill({
    status,
    showOk = false,
}: {
    status: MacroOutcome | null;
    showOk?: boolean;
}) {
    if (!status || (status === "ok" && !showOk)) return null;
    if (status === "failed") {
        return <Badge variant="destructive">{MACRO_STATUS_LABEL.failed}</Badge>;
    }
    if (status === "repaired") {
        return (
            <Badge variant="outline" className={AMBER}>
                {MACRO_STATUS_LABEL.repaired}
            </Badge>
        );
    }
    return <Badge variant="outline">{MACRO_STATUS_LABEL.ok}</Badge>;
}
