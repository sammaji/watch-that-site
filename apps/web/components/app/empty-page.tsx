import { Badge } from "@watchthatsite/ui/components/badge";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@watchthatsite/ui/components/card";
import type { LucideIcon } from "lucide-react";

export function EmptyPage({
    icon: Icon,
    eyebrow,
    title,
    description,
}: {
    icon: LucideIcon;
    eyebrow: string;
    title: string;
    description: string;
}) {
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
            <div className="space-y-2">
                <Badge variant="secondary">{eyebrow}</Badge>
                <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
                    {title}
                </h1>
            </div>
            <Card className="rounded-lg">
                <CardHeader className="border-b">
                    <CardTitle className="font-normal">{title}</CardTitle>
                    <CardDescription>{description}</CardDescription>
                </CardHeader>
                <CardContent className="flex min-h-64 items-center justify-center">
                    <div className="text-muted-foreground flex flex-col items-center gap-3 text-center">
                        <Icon className="size-10" />
                        <p className="text-sm">Nothing here yet.</p>

                        <Button>Hello</Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
