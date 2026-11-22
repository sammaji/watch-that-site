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
import { Check, Eye, EyeOff, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

function getAuthErrorMessage(error: unknown) {
    if (typeof error === "object" && error && "message" in error) {
        const message = (error as { message?: string }).message;

        if (message) return message;
    }

    return "Unable to create your account. Try again.";
}

function checkStrength(pass: string) {
    const requirements = [
        { regex: /.{8,}/, text: "At least 8 characters" },
        { regex: /[0-9]/, text: "At least 1 number" },
        { regex: /[a-z]/, text: "At least 1 lowercase letter" },
        { regex: /[A-Z]/, text: "At least 1 uppercase letter" },
    ];

    return requirements.map(req => ({
        met: req.regex.test(pass),
        text: req.text,
    }));
}

function getStrengthColor(score: number) {
    if (score === 0) return "bg-border";
    if (score <= 1) return "bg-red-500";
    if (score <= 2) return "bg-orange-500";
    if (score === 3) return "bg-amber-500";
    return "bg-emerald-500";
}

function getStrengthText(score: number) {
    if (score === 0) return "Enter a password";
    if (score <= 2) return "Weak password";
    if (score === 3) return "Medium password";
    return "Strong password";
}

export default function JoinPage() {
    const router = useRouter();
    const [pending, startTransition] = React.useTransition();
    const [error, setError] = React.useState<string | undefined>("");
    const [hasAgreed, setHasAgreed] = React.useState(true);
    const [isVisible, setIsVisible] = React.useState(false);
    const [password, setPassword] = React.useState("");
    const strength = checkStrength(password);
    const strengthScore = strength.filter(req => req.met).length;
    const isValid = hasAgreed && strengthScore === 4;

    const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const name = String(formData.get("name") ?? "");
        const email = String(formData.get("email") ?? "");

        startTransition(async () => {
            const res = await authClient.signUp.email({
                name,
                email,
                password,
            });

            if (res.error) {
                setError(getAuthErrorMessage(res.error));
                return;
            }

            if (res.data) {
                router.push("/verify");
            }
        });
    };

    const handleGoogleSignIn = () => {
        startTransition(async () => {
            const res = await authClient.signIn.social({
                provider: "google",
                callbackURL: "/home",
            });

            if (res.error) setError(getAuthErrorMessage(res.error));
            if (res.data && res.data.redirect) {
                router.push(res.data.url || "/home");
            }
        });
    };

    return (
        <Card className="w-full max-w-sm">
            <CardHeader className="border-b">
                <CardTitle className="text-xl font-normal">
                    Create an account
                </CardTitle>
                <CardDescription>
                    Enter your info to create your account.
                </CardDescription>
                {error ?
                    <p className="text-destructive">{error}</p>
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
                            <Label htmlFor="name">Name</Label>
                            <Input
                                id="name"
                                name="name"
                                type="text"
                                placeholder="Enter your full name"
                                required
                                minLength={2}
                            />
                        </div>
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
                            <Label htmlFor="password">Password</Label>
                            <div className="relative">
                                <Input
                                    id="password"
                                    name="password"
                                    type={isVisible ? "text" : "password"}
                                    placeholder="Enter your password"
                                    value={password}
                                    onChange={event =>
                                        setPassword(event.target.value)
                                    }
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

                        {password ?
                            <div>
                                <div
                                    className="bg-border mb-4 h-1 w-full overflow-hidden rounded-full"
                                    role="progressbar"
                                    aria-valuenow={strengthScore}
                                    aria-valuemin={0}
                                    aria-valuemax={4}
                                    aria-label="Password strength">
                                    <div
                                        className={`h-full ${getStrengthColor(strengthScore)} transition-all duration-500 ease-out`}
                                        style={{
                                            width: `${(strengthScore / 4) * 100}%`,
                                        }}
                                    />
                                </div>
                                <p className="text-foreground mb-2 text-sm font-medium">
                                    {getStrengthText(strengthScore)}. Must
                                    contain:
                                </p>
                                <ul
                                    className="space-y-1.5"
                                    aria-label="Password requirements">
                                    {strength.map(req => (
                                        <li
                                            key={req.text}
                                            className="flex items-center gap-2">
                                            {req.met ?
                                                <Check
                                                    size={16}
                                                    className="text-emerald-500"
                                                    aria-hidden="true"
                                                />
                                            :   <X
                                                    size={16}
                                                    className="text-muted-foreground/80"
                                                    aria-hidden="true"
                                                />
                                            }
                                            <span
                                                className={`text-xs ${req.met ? "text-emerald-600" : "text-muted-foreground"}`}>
                                                {req.text}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        :   null}

                        <div className="flex items-center gap-2">
                            <input
                                id="agree-tac"
                                checked={hasAgreed}
                                className="size-4 rounded border"
                                type="checkbox"
                                onChange={event =>
                                    setHasAgreed(event.target.checked)
                                }
                            />
                            <Label htmlFor="agree-tac">
                                I agree to the{" "}
                                <Link
                                    className="text-primary no-underline hover:underline"
                                    href="/legal/terms-and-conditions">
                                    Terms and Conditions
                                </Link>
                            </Label>
                        </div>
                        <Button
                            disabled={!isValid}
                            isLoading={pending}
                            type="submit"
                            className="w-full">
                            Create account
                        </Button>
                    </div>
                </form>
            </CardContent>
            <CardFooter className="flex-col gap-4">
                <p>
                    Already have an account?{" "}
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
