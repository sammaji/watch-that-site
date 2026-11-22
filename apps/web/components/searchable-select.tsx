"use client";

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@watchthatsite/ui/components/popover";
import { cn } from "@watchthatsite/ui/lib/utils";
import { Check, ChevronDown, Search } from "lucide-react";
import * as React from "react";

export interface SearchableOption {
    value: string;
    /** What the list shows and what the search matches. */
    label: string;
    /** Shown before the label, e.g. a provider logo. */
    icon?: React.ReactNode;
    /** Muted text after the label; also searched. */
    hint?: string;
}

/**
 * A select with a search box, for lists too long to scroll through (a
 * provider can list dozens of models). Type to filter, arrow keys to move,
 * Enter to choose, Escape to close.
 */
export function SearchableSelect({
    id,
    value,
    options,
    onChange,
    placeholder,
    searchPlaceholder = "Search…",
    empty = "Nothing matches.",
    disabled,
}: {
    id?: string;
    value: string | null;
    options: SearchableOption[];
    onChange: (value: string) => void;
    placeholder: string;
    searchPlaceholder?: string;
    empty?: string;
    disabled?: boolean;
}) {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const [active, setActive] = React.useState(0);
    const listRef = React.useRef<HTMLDivElement>(null);
    const listId = React.useId();

    const selected = options.find(o => o.value === value) ?? null;
    const q = query.trim().toLowerCase();
    const shown =
        q ?
            options.filter(o =>
                `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q),
            )
        :   options;

    React.useEffect(() => {
        listRef.current
            ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [active, open]);

    const choose = (option: SearchableOption | undefined) => {
        if (!option) return;
        onChange(option.value);
        setOpen(false);
    };

    return (
        <Popover
            open={open}
            onOpenChange={next => {
                // Each opening starts with an empty search, on the current choice.
                if (next) {
                    setQuery("");
                    const at = options.findIndex(o => o.value === value);
                    setActive(at >= 0 ? at : 0);
                }
                setOpen(next);
            }}>
            <PopoverTrigger asChild>
                <button
                    id={id}
                    type="button"
                    role="combobox"
                    aria-expanded={open}
                    aria-controls={listId}
                    disabled={disabled}
                    className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50">
                    {selected ?
                        <>
                            {selected.icon}
                            <span className="truncate">{selected.label}</span>
                            {selected.hint ?
                                <span className="text-muted-foreground truncate">
                                    {selected.hint}
                                </span>
                            :   null}
                        </>
                    :   <span className="text-muted-foreground truncate">
                            {placeholder}
                        </span>
                    }
                    <ChevronDown className="text-muted-foreground ml-auto size-4 shrink-0" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-(--radix-popover-trigger-width) min-w-56 p-0"
                // Keep focus in the search box rather than the first option.
                onOpenAutoFocus={e => e.preventDefault()}>
                <div className="flex items-center gap-2 border-b px-3">
                    <Search className="text-muted-foreground size-4 shrink-0" />
                    <input
                        autoFocus
                        value={query}
                        onChange={e => {
                            setQuery(e.target.value);
                            setActive(0);
                        }}
                        onKeyDown={e => {
                            if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setActive(i =>
                                    Math.min(i + 1, shown.length - 1),
                                );
                            } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setActive(i => Math.max(i - 1, 0));
                            } else if (e.key === "Enter") {
                                e.preventDefault();
                                choose(shown[active]);
                            }
                        }}
                        placeholder={searchPlaceholder}
                        aria-controls={listId}
                        aria-activedescendant={
                            shown[active] ? `${listId}-${active}` : undefined
                        }
                        className="placeholder:text-muted-foreground h-9 w-full bg-transparent text-sm outline-none"
                    />
                </div>
                <div
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    className="max-h-64 overflow-y-auto p-1">
                    {shown.length === 0 ?
                        <p className="text-muted-foreground px-2 py-6 text-center text-sm">
                            {empty}
                        </p>
                    :   shown.map((o, i) => (
                            <div
                                key={o.value}
                                id={`${listId}-${i}`}
                                data-index={i}
                                role="option"
                                aria-selected={o.value === value}
                                onMouseEnter={() => setActive(i)}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => choose(o)}
                                className={cn(
                                    "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none",
                                    i === active &&
                                        "bg-accent text-accent-foreground",
                                )}>
                                {o.icon}
                                <span className="truncate">{o.label}</span>
                                {o.hint ?
                                    <span className="text-muted-foreground truncate">
                                        {o.hint}
                                    </span>
                                :   null}
                                {o.value === value ?
                                    <Check className="ml-auto size-4 shrink-0" />
                                :   null}
                            </div>
                        ))
                    }
                </div>
            </PopoverContent>
        </Popover>
    );
}
