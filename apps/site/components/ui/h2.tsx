import * as React from "react";

import { cn } from "@watchthatsite/ui/lib/utils";

function H2({ className, ...props }: React.ComponentProps<"h2">) {
    return (
        <h2
            className={cn(
                "mb-6 text-3xl font-medium text-white sm:text-4xl",
                className,
            )}
            {...props}
        />
    );
}

export { H2 };
