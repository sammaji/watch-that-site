import * as React from "react";

import { cn } from "@watchthatsite/ui/lib/utils";

function H3({ className, ...props }: React.ComponentProps<"h3">) {
    return (
        <h3
            className={cn(
                "mb-3 text-2xl tracking-[-1px] text-white",
                className,
            )}
            {...props}
        />
    );
}

export { H3 };
