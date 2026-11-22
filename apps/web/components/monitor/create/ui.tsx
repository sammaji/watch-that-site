import { Label } from "@watchthatsite/ui/components/label";
import { Switch } from "@watchthatsite/ui/components/switch";
import { cn } from "@watchthatsite/ui/lib/utils";
import type React from "react";

/** Small layout helpers shared by the Monitor form and the Monitor page. */

export function Section({
    title,
    description,
    children,
    className,
}: {
    title: string;
    description?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={cn("space-y-3", className)}>
            <div className="space-y-1">
                <h2 className="text-sm font-medium">{title}</h2>
                {description ?
                    <p className="text-muted-foreground text-xs">
                        {description}
                    </p>
                :   null}
            </div>
            {children}
        </section>
    );
}

export function FieldError({ message }: { message?: string | null }) {
    if (!message) return null;
    return (
        <p role="alert" className="text-destructive text-sm">
            {message}
        </p>
    );
}

export function SwitchRow({
    id,
    label,
    checked,
    onChange,
    description,
}: {
    id: string;
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    description?: string;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
                <Label htmlFor={id} className="font-normal">
                    {label}
                </Label>
                {description ?
                    <p className="text-muted-foreground text-xs">
                        {description}
                    </p>
                :   null}
            </div>
            <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </div>
    );
}
