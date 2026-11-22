import { dbPool } from "@watchthatsite/db/pool";
import { resend, resetPassword, verificationLink } from "@watchthatsite/email";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { bearer, jwt } from "better-auth/plugins";
import { deleteGatewayAccount } from "./gateway";

export const auth = betterAuth({
    database: dbPool,
    appName: "WatchThatSite",
    trustedOrigins: [process.env.NEXT_PUBLIC_APP_URL!],
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async data => {
            const { data: success, error } = await resend.emails.send({
                from: `${process.env.SMTP_SENDER_NAME} <${process.env.SMTP_MAIL}>`,
                to: [data.user.email],
                ...resetPassword(data.url, data.user.email),
            });
            if (error) console.error(error);
            if (success) console.log(success);
        },
    },
    emailVerification: {
        sendVerificationEmail: async data => {
            const { data: success, error } = await resend.emails.send({
                from: `${process.env.SMTP_SENDER_NAME} <${process.env.SMTP_MAIL}>`,
                to: [data.user.email],
                ...verificationLink(data.url, data.user.name),
            });
            if (error) console.error(error);
            if (success) console.log(success);
        },
        sendOnSignUp: true,
        sendOnSignIn: true, // send email if user is not verified
        // Confirming the address signs the person in, so the link lands
        // them in the app rather than on the sign-in page.
        autoSignInAfterVerification: true,
    },
    user: {
        modelName: "users",
        // Deleting the users row cascades to everything the account owns,
        // its secrets included (schema.sql). What the account holds in the
        // model gateway is removed first (gateway.ts).
        deleteUser: {
            enabled: true,
            beforeDelete: async user => {
                try {
                    await deleteGatewayAccount(user.id);
                } catch (error) {
                    console.error(
                        "[auth] could not clear the account from the model gateway:",
                        error instanceof Error ?
                            error.message
                        :   "unknown error",
                    );
                    throw new APIError("SERVICE_UNAVAILABLE", {
                        message:
                            "Your account could not be deleted right now. Try again in a few minutes.",
                    });
                }
            },
        },
        fields: {
            emailVerified: "email_verified",
            createdAt: "created_at",
            updatedAt: "updated_at",
        },
    },
    session: {
        modelName: "sessions",
        fields: {
            updatedAt: "updated_at",
            expiresAt: "expires_at",
            createdAt: "created_at",
            ipAddress: "ip_address",
            userAgent: "user_agent",
            userId: "user_id",
        },
    },
    account: {
        modelName: "accounts",
        fields: {
            accountId: "account_id",
            providerId: "provider_id",
            userId: "user_id",
            accessToken: "access_token",
            refreshToken: "refresh_token",
            idToken: "id_token",
            accessTokenExpiresAt: "access_token_expires_at",
            refreshTokenExpiresAt: "refresh_token_expires_at",
            createdAt: "created_at",
            updatedAt: "updated_at",
        },
    },
    verification: {
        modelName: "verifications",
        fields: {
            expiresAt: "expires_at",
            createdAt: "created_at",
            updatedAt: "updated_at",
        },
    },
    socialProviders: {
        google: {
            enabled: true,
            prompt: "select_account",
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
        discord: {
            clientId: process.env.DISCORD_CLIENT_ID!,
            clientSecret: process.env.DISCORD_CLIENT_SECRET!,
            permissions: 2048 | 16384,
            scope: ["bot"],
        },
    },
    plugins: [
        jwt({
            jwt: {
                // PostgREST reads user_id (rls.sql uid()) and role.
                definePayload: async ({ user }) => ({
                    sub: user.id,
                    user_id: user.id,
                    role: "authenticated",
                    email: user.email,
                }),
                issuer: process.env.BETTER_AUTH_URL,
                audience: process.env.PGRST_JWT_AUD,
                expirationTime: "1h",
            },
            schema: {
                jwks: {
                    fields: {
                        publicKey: "public_key",
                        privateKey: "private_key",
                        createdAt: "created_at",
                        expiresAt: "expires_at",
                    },
                },
            },
        }),

        bearer(),

        nextCookies(),
    ],
});
