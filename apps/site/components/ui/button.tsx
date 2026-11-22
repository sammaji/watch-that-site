import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@watchthatsite/ui/lib/utils";

const buttonVariants = cva(
    "group relative inline-flex cursor-pointer items-center justify-center overflow-hidden text-base transition-all duration-300 disabled:pointer-events-none disabled:opacity-50",
    {
        variants: {
            variant: {
                default:
                    "bg-white/5 text-white ring ring-white/40 hover:bg-white/10",
                primary: "text-theme-dark-500 bg-white hover:bg-white/90",
                outline:
                    "border border-white/40 bg-white/5 text-white hover:bg-white/10",
                ghost: "text-white ring ring-transparent",
                subtle: "bg-white/5 text-white ring ring-white/40 hover:bg-white/10",
                white: "bg-white hover:bg-gray-100",
                plain: "text-white",
            },
            size: {
                default: "w-auto px-6 py-3",
                nav: "px-6 py-3.5 font-medium leading-5 -tracking-[0.2px]",
                icon: "size-12",
                full: "w-full px-6 py-3",
                unset: "",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
);

function Button({
    className,
    variant,
    size,
    asChild = false,
    ...props
}: React.ComponentProps<"a"> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
    }) {
    const Comp = asChild ? Slot.Root : "a";

    return (
        <Comp
            data-slot="button"
            className={cn(buttonVariants({ variant, size, className }))}
            {...props}
        />
    );
}

export { Button, buttonVariants };
