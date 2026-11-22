"use client";

import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@watchthatsite/ui/components/card";

export default function VerifyPage() {
    return (
        <Card className="w-full max-w-sm">
            <CardHeader>
                <CardTitle className="text-xl font-normal">
                    Verification email sent!
                </CardTitle>
                <CardDescription>
                    A verification email has been sent to your email address. If
                    you do not find it, please check your spam folder.
                </CardDescription>
            </CardHeader>
        </Card>
    );
}
