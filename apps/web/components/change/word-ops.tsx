"use client";

import type { TextOp, WordOp } from "@watchthatsite/types";
import { Badge } from "@watchthatsite/ui/components/badge";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@watchthatsite/ui/components/tooltip";
import { cn } from "@watchthatsite/ui/lib/utils";
import { ADDED_CLASS, OP_LABEL, REMOVED_CLASS, selfChangingCopy } from "./lib";

/** Text the Comparator left out because it changes on its own. */
function SelfChanging({ text, kind }: { text: string; kind: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    tabIndex={0}
                    className="text-muted-foreground bg-muted cursor-help rounded-sm px-0.5 underline decoration-dotted underline-offset-2">
                    {text}
                </span>
            </TooltipTrigger>
            <TooltipContent>
                Not compared: {selfChangingCopy(kind)} changes on its own
            </TooltipContent>
        </Tooltip>
    );
}

/**
 * Renders a modify op's word diff. `side` limits it to one side
 * ("before" drops additions, "after" drops removals).
 */
export function WordDiff({
    tokens,
    side = "both",
}: {
    tokens: WordOp[];
    side?: "both" | "before" | "after";
}) {
    return (
        <>
            {tokens.map((token, i) => {
                if (token.op === "+" && side === "before") return null;
                if (token.op === "-" && side === "after") return null;
                if (token.mask) {
                    return (
                        <SelfChanging
                            key={i}
                            text={token.text}
                            kind={token.mask}
                        />
                    );
                }
                if (token.op === "+") {
                    return (
                        <ins
                            key={i}
                            className={cn(ADDED_CLASS, "no-underline")}>
                            {token.text}
                        </ins>
                    );
                }
                if (token.op === "-") {
                    return (
                        <del key={i} className={REMOVED_CLASS}>
                            {token.text}
                        </del>
                    );
                }
                return <span key={i}>{token.text}</span>;
            })}
        </>
    );
}

/** The body of one op: word diff, added, removed, moved or ignored text. */
export function OpBody({
    op,
    side = "both",
}: {
    op: TextOp;
    side?: "both" | "before" | "after";
}) {
    if (op.op === "modify" && op.tokens?.length) {
        return <WordDiff tokens={op.tokens} side={side} />;
    }
    if (op.op === "modify") {
        return (
            <>
                {side !== "after" && op.old_text ?
                    <del className={REMOVED_CLASS}>{op.old_text}</del>
                :   null}{" "}
                {side !== "before" ?
                    <ins className={cn(ADDED_CLASS, "no-underline")}>
                        {op.text}
                    </ins>
                :   null}
            </>
        );
    }
    if (op.op === "add") {
        return <ins className={cn(ADDED_CLASS, "no-underline")}>{op.text}</ins>;
    }
    if (op.op === "remove") {
        return <del className={REMOVED_CLASS}>{op.text}</del>;
    }
    if (op.op === "move") {
        return (
            <span>
                <span aria-hidden className="text-sky-600 dark:text-sky-400">
                    ↪{" "}
                </span>
                {op.text}
            </span>
        );
    }
    // ignored
    return (
        <span className="text-muted-foreground">
            {op.old_text ?
                <>
                    <span className="line-through">{op.old_text}</span> →{" "}
                </>
            :   null}
            {op.text}
        </span>
    );
}

const KIND_CLASS: Record<TextOp["op"], string> = {
    add: "bg-[#e6ffec] text-[#1a7f37] dark:bg-[#2ea043]/25 dark:text-[#56d364]",
    remove: "bg-[#ffebe9] text-[#cf222e] dark:bg-[#f85149]/20 dark:text-[#ff7b72]",
    modify: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    move: "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-300",
    ignored: "bg-muted text-muted-foreground",
};

export function OpKindBadge({ op }: { op: TextOp }) {
    return (
        <Badge
            variant="secondary"
            className={cn("rounded-md", KIND_CLASS[op.op])}>
            {op.op === "move" ? "↪ moved" : OP_LABEL[op.op]}
        </Badge>
    );
}
