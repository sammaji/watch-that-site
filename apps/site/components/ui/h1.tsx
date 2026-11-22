import * as React from "react";

import { cn } from "@watchthatsite/ui/lib/utils";

function H1({ className, ...props }: React.ComponentProps<"h1">) {
    return (
        <h1
            className={cn(
                "mb-6 text-center text-4xl font-normal tracking-[-1.5px] text-white lg:text-5xl xl:text-6xl xl:leading-16",
                className,
            )}
            {...props}
        />
    );
}

export { H1 };
