"use client";

import { ObjectImage } from "@/components/change/object-image";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@watchthatsite/ui/components/dialog";
import { cn } from "@watchthatsite/ui/lib/utils";

/**
 * The screenshot taken after a step, as a thumbnail that opens full size.
 * Step screenshots show the top of the page as the browser saw it.
 */
export function StepShot({
    screenshotKey,
    caption,
    className,
}: {
    screenshotKey: string;
    /** What the step was, for the dialog title and the image's alt text. */
    caption: string;
    className?: string;
}) {
    return (
        <Dialog>
            <DialogTrigger
                aria-label={`Open the screenshot of “${caption}”`}
                className={cn(
                    "focus-visible:ring-ring/50 block w-28 shrink-0 cursor-zoom-in overflow-hidden rounded-md border outline-none focus-visible:ring-[3px] sm:w-36",
                    className,
                )}>
                <div className="bg-muted aspect-[16/10] overflow-hidden">
                    <ObjectImage
                        objectKey={screenshotKey}
                        alt={`Screenshot after “${caption}”`}
                        unavailableText="Screenshot not stored"
                        className="h-full min-h-0 object-cover object-top"
                    />
                </div>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle className="pr-6 text-base break-words">
                        {caption}
                    </DialogTitle>
                    <DialogDescription>
                        The page right after this step.
                    </DialogDescription>
                </DialogHeader>
                <ObjectImage
                    objectKey={screenshotKey}
                    alt={`Screenshot after “${caption}”`}
                    className="rounded-md border"
                />
            </DialogContent>
        </Dialog>
    );
}
