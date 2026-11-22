import { auth } from "@watchthatsite/auth/next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth.api.getSession({ headers: await headers() });

    if (session) {
        redirect("/home");
    }

    return (
        <div className="bg-muted/30 flex min-h-[100dvh] items-center justify-center px-2 py-8">
            {children}
        </div>
    );
}
