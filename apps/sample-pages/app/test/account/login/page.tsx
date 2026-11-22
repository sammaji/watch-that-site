import type { Metadata } from "next";
import { Fixture, h1Style, pStyle } from "../../diff/_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in to Northwind" };

const fieldStyle = {
    display: "block",
    width: 320,
    margin: "4px 0 16px",
    padding: "8px 10px",
    border: "1px solid #8c959f",
    borderRadius: 6,
    font: "inherit",
} as const;

/** The sign-in page of the account fixture. The password is `northwind-demo`. */
export default async function AccountLogin({
    searchParams,
}: {
    searchParams: Promise<{ error?: string }>;
}) {
    const { error } = await searchParams;
    return (
        <Fixture scenario="account" variant="login">
            <h1 style={h1Style}>Sign in to Northwind</h1>
            {error ?
                <p role="alert" style={{ ...pStyle, color: "#b42318" }}>
                    That email and password do not match.
                </p>
            :   null}
            <form method="post" action="/test/account/session">
                <label htmlFor="email">Email</label>
                <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    style={fieldStyle}
                />
                <label htmlFor="password">Password</label>
                <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    style={fieldStyle}
                />
                <button
                    type="submit"
                    style={{
                        padding: "8px 16px",
                        border: 0,
                        borderRadius: 6,
                        background: "#1f6feb",
                        color: "#ffffff",
                        font: "inherit",
                    }}>
                    Sign in
                </button>
            </form>
        </Fixture>
    );
}
