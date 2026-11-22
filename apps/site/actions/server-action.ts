"use server";
import { actionClient } from "./safe-action";

import { formSchema } from "@/lib/form-schema";

export const serverAction = actionClient
    .inputSchema(formSchema)
    .action(async ({ parsedInput }) => {
        const res = await fetch(
            "https://nocodb.sammaji.com/api/v3/data/prvo9vofv84o31o/mpveb1fc30q9nwe/records",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "xc-token": process.env.NOCODB_API_TOKEN!,
                },
                body: JSON.stringify([
                    {
                        fields: {
                            email: parsedInput.email,
                            full_name: parsedInput.name,
                            company: parsedInput.company ?? "",
                            num_employee: parsedInput.employees ?? "",
                            message: parsedInput.message,
                        },
                    },
                ]),
            },
        );

        if (!res.ok) {
            const message = await res.text();
            throw new Error(
                `Failed to submit contact form: ${res.status} ${message}`,
            );
        }

        return {
            success: true,
            message: "Form submitted successfully",
        };
    });
