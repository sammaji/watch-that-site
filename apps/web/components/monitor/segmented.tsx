"use client";

import { cn } from "@watchthatsite/ui/lib/utils";

/** A row of pressed/unpressed buttons choosing one value. */
export function Segmented<T extends string>({
    label,
    value,
    onChange,
    options,
    size = "default",
    disabled,
    className,
}: {
    label: string;
    value: T;
    onChange: (value: T) => void;
    options: ReadonlyArray<{ value: T; label: string; testId?: string }>;
    size?: "default" | "sm";
    disabled?: boolean;
    className?: string;
}) {
    return (
        <div
            role="group"
            aria-label={label}
            className={cn(
                "bg-muted inline-flex max-w-full flex-wrap gap-0.5 rounded-lg p-0.5",
                className,
            )}>
            {options.map(option => {
                const on = value === option.value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={on}
                        disabled={disabled}
                        data-testid={option.testId}
                        onClick={() => onChange(option.value)}
                        className={cn(
                            "focus-visible:ring-ring/50 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] disabled:opacity-50",
                            size === "sm" ? "h-6 px-2 text-xs" : (
                                "h-7 px-2.5 text-[0.8rem]"
                            ),
                            on ?
                                "bg-background text-foreground dark:bg-input/60 shadow-sm"
                            :   "text-muted-foreground hover:text-foreground",
                        )}>
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
