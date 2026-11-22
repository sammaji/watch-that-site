import { ACCOUNT_COOKIE } from "@/lib/account";
import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Fixture, h1Style } from "../diff/_components/fixture";
import { AccountClient } from "./account-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Northwind account" };

/**
 * An account area behind a sign-in, for Macros: the annual price is only
 * visible after signing in, opening the billing tab and switching to Annual.
 */
export default async function AccountFixture() {
    if ((await cookies()).get(ACCOUNT_COOKIE)?.value !== "1") {
        redirect("/test/account/login");
    }
    const variant = getVariant("account");
    return (
        <Fixture scenario="account" variant={variant}>
            <h1 style={h1Style}>Northwind account</h1>
            <AccountClient
                billingLabel={
                    variant === "renamed" ? "Plans & invoices" : "Billing"
                }
                annualPrice={variant === "v1" ? "$948" : "$1,188"}
            />
        </Fixture>
    );
}
