import { auth } from "@watchthatsite/auth/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function IndexPage() {
    const session = await auth.api.getSession({ headers: await headers() });
    redirect(session ? "/home" : "/login");
}
