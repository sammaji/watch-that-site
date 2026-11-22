import { Resend } from "resend";

export type { Email } from "./layout";
export { resetPassword } from "./reset-password";
export { verificationLink } from "./verification-link";

let client: Resend | null = null;

export function resend(): Resend {
    client ??= new Resend(process.env.RESEND_API_KEY);
    return client;
}
