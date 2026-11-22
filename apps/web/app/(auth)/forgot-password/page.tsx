"use client";

import { authClient } from "@watchthatsite/auth/client";
import { Button } from "@watchthatsite/ui/components/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@watchthatsite/ui/components/card";
import { Input } from "@watchthatsite/ui/components/input";
import { Label } from "@watchthatsite/ui/components/label";
import Link from "next/link";
import * as React from "react";

export default function ForgotpasswordPage() {
    const [pending, startTransition] = React.useTransition();
    const [error, setError] = React.useState<string | undefined>();
    const [success, setSuccess] = React.useState<string | undefined>();

    const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const email = String(formData.get("email") ?? "");

        startTransition(async () => {
            setError(undefined);
            setSuccess(undefined);
            const res = await authClient.requestPasswordReset({
                email,
                redirectTo: "/update-password",
            });

            if (res.error) {
                setError(res.error.message ?? "Authentication action failed");
                return;
            }

            setSuccess("Check your email for reset link.");
        });
    };

    return (
        <Card className="w-full max-w-sm">
            <CardHeader className="border-b">
                <CardTitle className="text-xl font-normal">
                    Forgot password
                </CardTitle>
                <CardDescription>
                    Enter your email to reset your password.
                </CardDescription>
                {error ?
                    <p className="text-destructive text-sm">{error}</p>
                :   null}
                {success ?
                    <p className="text-sm text-emerald-600">{success}</p>
                :   null}
            </CardHeader>
            <CardContent>
                <form onSubmit={onSubmit}>
                    <div className="flex flex-col gap-6">
                        <div className="grid gap-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                                id="email"
                                name="email"
                                type="email"
                                placeholder="Enter your email"
                                required
                            />
                        </div>
                        <Button
                            isLoading={pending}
                            type="submit"
                            className="w-full">
                            Send reset link
                        </Button>
                    </div>
                </form>
            </CardContent>
            <CardFooter className="flex-col gap-4">
                <p>
                    Back to{" "}
                    <Link
                        className="text-primary no-underline hover:underline"
                        href="/login">
                        Login
                    </Link>
                </p>
            </CardFooter>
        </Card>
    );
}
