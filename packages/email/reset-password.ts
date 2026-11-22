import { render, type Email } from "./layout";

/** Sent when someone asks to reset an account's password. */
export function resetPassword(url: string, email: string): Email {
    return render("Reset your WatchThatSite password", {
        preview: "Choose a new password for your account.",
        heading: "Reset your password",
        body: [
            `Someone asked to reset the password for ${email}. If that was you, choose a new one below.`,
        ],
        button: { label: "Choose a new password", url },
        note: "The link works for one hour. If you did not ask for this, ignore this email: your password stays the same.",
    });
}
