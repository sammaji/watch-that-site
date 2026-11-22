import { Resend } from "resend";

export type { Email } from "./layout";
export { resetPassword } from "./reset-password";
export { verificationLink } from "./verification-link";

export const resend = new Resend(process.env.RESEND_API_KEY);
