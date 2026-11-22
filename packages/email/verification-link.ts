import { render, type Email } from "./layout";

/** Sent on sign-up (and on sign-in while unconfirmed) to confirm the address. */
export function verificationLink(url: string, name?: string | null): Email {
    const first = name?.trim().split(/\s+/)[0];
    return render("Confirm your email for WatchThatSite", {
        preview: "One click to finish setting up your account.",
        heading: "Confirm your email",
        body: [
            `${first ? `Hi ${first}, thanks` : "Thanks"} for signing up to WatchThatSite. Confirm this is your email address to finish setting up your account.`,
        ],
        button: { label: "Confirm email", url },
        note: "The link works for one hour. If you did not sign up, you can ignore this email.",
    });
}
