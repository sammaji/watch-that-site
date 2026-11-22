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
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

function getAuthErrorMessage(error: unknown) {
    if (typeof error === "object" && error && "message" in error) {
        const message = (error as { message?: string }).message;

        if (message) return message;
    }

    return "Unable to login. Check your credentials and try again.";
}

export default function LoginPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const redirectUrl = searchParams.get("redirect") || "/home";
    const [error, setError] = React.useState<string | undefined>();
    const [pending, startTransition] = React.useTransition();
    const [isVisible, setIsVisible] = React.useState(false);

    const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const email = String(formData.get("email") ?? "");
        const password = String(formData.get("password") ?? "");

        startTransition(async () => {
            const res = await authClient.signIn.email({
                email,
                password,
                rememberMe: true,
                callbackURL: redirectUrl,
            });

            if (res.error) {
                setError(getAuthErrorMessage(res.error));
                return;
            }

            if (res.data) {
                router.push(redirectUrl);
            }
        });
    };

    const handleGoogleSignIn = () => {
        startTransition(async () => {
            const res = await authClient.signIn.social({
                provider: "google",
                callbackURL: redirectUrl,
            });

            if (res.error) setError(getAuthErrorMessage(res.error));
            if (res.data && res.data.redirect) {
                router.push(res.data.url || redirectUrl);
            }
        });
    };

    return (
        <Card className="w-full max-w-sm">
            <CardHeader className="border-b">
                <CardTitle className="text-xl font-normal">Login</CardTitle>
                <CardDescription>
                    Enter your email and password to login.
                </CardDescription>
                {error ?
                    <p className="text-destructive text-sm">{error}</p>
                :   null}
            </CardHeader>
            <CardContent>
                <Button
                    className="w-full"
                    variant="outline"
                    isLoading={pending}
                    onClick={handleGoogleSignIn}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt="" className="h-4 w-4" src="/images/google.svg" />
                    Sign in with Google
                </Button>
                <div className="my-4 flex items-center gap-2">
                    <hr className="grow" />
                    <p className="text-muted-foreground text-sm">Or</p>
                    <hr className="grow" />
                </div>
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
                        <div className="grid gap-2">
                            <div className="flex items-center">
                                <Label htmlFor="password">Password</Label>
                                <Link
                                    href="/forgot-password"
                                    className="ml-auto inline-block text-sm no-underline hover:underline">
                                    Forgot password
                                </Link>
                            </div>
                            <div className="relative">
                                <Input
                                    id="password"
                                    name="password"
                                    type={isVisible ? "text" : "password"}
                                    placeholder="Enter your password"
                                    required
                                />
                                <button
                                    className="text-muted-foreground/80 hover:text-foreground focus-visible:outline-ring/70 absolute inset-y-0 end-0 flex h-full w-9 items-center justify-center rounded-e-lg outline-offset-2 transition-colors focus:z-10 focus-visible:outline-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
                                    type="button"
                                    onClick={() =>
                                        setIsVisible(value => !value)
                                    }
                                    aria-label={
                                        isVisible ? "Hide password" : (
                                            "Show password"
                                        )
                                    }
                                    aria-pressed={isVisible}
                                    aria-controls="password">
                                    {isVisible ?
                                        <Eye
                                            size={16}
                                            strokeWidth={2}
                                            aria-hidden="true"
                                        />
                                    :   <EyeOff
                                            size={16}
                                            strokeWidth={2}
                                            aria-hidden="true"
                                        />
                                    }
                                </button>
                            </div>
                        </div>

                        <Button
                            isLoading={pending}
                            type="submit"
                            className="w-full">
                            Login
                        </Button>
                    </div>
                </form>
            </CardContent>
            <CardFooter className="flex-col gap-4">
                <p>
                    Don&apos;t have an account?{" "}
                    <Link
                        className="text-primary no-underline hover:underline"
                        href="/signup">
                        Register
                    </Link>
                </p>
            </CardFooter>
        </Card>
    );
}
