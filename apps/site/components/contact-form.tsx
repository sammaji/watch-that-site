"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { serverAction } from "@/actions/server-action";
import { formSchema } from "@/lib/form-schema";

type Schema = z.infer<typeof formSchema>;

const inputClassName =
    "h-12 w-full border border-white/20 bg-white/5 p-5 text-white placeholder:text-white/80 focus:border-white/50 focus:outline-0";
const selectClassName =
    "h-12 w-full border border-white/20 bg-white/5 px-5 py-0 text-white focus:border-white/50 focus:outline-0";
const errorClassName = "mt-1 text-sm text-red-300";

export function ContactForm() {
    const form = useForm<Schema>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            name: "",
            email: "",
            company: "",
            employees: "",
            message: "",
            agree: true,
        } as unknown as Schema,
    });
    const formAction = useAction(serverAction, {
        onSuccess: () => {
            form.reset();
        },
    });
    const handleSubmit = form.handleSubmit(async (data: Schema) => {
        formAction.execute({
            ...data,
            agree: true,
        });
    });

    if (formAction.hasSucceeded) {
        return (
            <div className="relative border border-white/20 px-6 py-8 text-center text-white">
                <div className="mx-auto mb-4 flex w-fit justify-center rounded-full border border-white/20 p-2">
                    <Check className="size-8" />
                </div>
                <h2 className="mb-2 text-2xl font-bold">Thank you</h2>
                <p className="text-white/80">
                    Your message has been submitted successfully.
                </p>
            </div>
        );
    }

    return (
        <div className="relative border border-white/20 px-6 py-8">
            <form onSubmit={handleSubmit}>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <div>
                        <input
                            {...form.register("name")}
                            placeholder="Name*"
                            className={inputClassName}
                            required
                            type="text"
                        />
                        {form.formState.errors.name?.message ?
                            <p className={errorClassName}>
                                {form.formState.errors.name.message}
                            </p>
                        :   null}
                    </div>
                    <div>
                        <input
                            {...form.register("email")}
                            placeholder="Email*"
                            className={inputClassName}
                            required
                            type="email"
                        />
                        {form.formState.errors.email?.message ?
                            <p className={errorClassName}>
                                {form.formState.errors.email.message}
                            </p>
                        :   null}
                    </div>
                    <div>
                        <input
                            {...form.register("company")}
                            placeholder="Company"
                            className={inputClassName}
                            type="text"
                        />
                        {form.formState.errors.company?.message ?
                            <p className={errorClassName}>
                                {form.formState.errors.company.message}
                            </p>
                        :   null}
                    </div>
                    <div>
                        <select
                            {...form.register("employees")}
                            className={selectClassName}
                            defaultValue="">
                            <option className="text-black" value="">
                                Number of employees
                            </option>
                            <option className="text-black" value="1">
                                1
                            </option>
                            <option className="text-black" value="2-10">
                                2-10
                            </option>
                            <option className="text-black" value="11-50">
                                11-50
                            </option>
                            <option className="text-black" value="51-500">
                                51-500
                            </option>
                            <option className="text-black" value="500+">
                                500+
                            </option>
                        </select>
                        {form.formState.errors.employees?.message ?
                            <p className={errorClassName}>
                                {form.formState.errors.employees.message}
                            </p>
                        :   null}
                    </div>
                    <div className="col-span-full">
                        <textarea
                            {...form.register("message")}
                            className="h-32 w-full border border-white/20 bg-white/5 p-5 px-5 py-3 text-white placeholder:text-white/80 focus:border-white/50 focus:outline-0"
                            placeholder="Write your message*"
                        />
                        {form.formState.errors.message?.message ?
                            <p className={errorClassName}>
                                {form.formState.errors.message.message}
                            </p>
                        :   null}
                    </div>
                </div>
                {formAction.hasErrored ?
                    <p className="mt-4 text-sm text-red-300">
                        Failed to submit message. Please try again.
                    </p>
                :   null}
                <div className="mt-6">
                    <button
                        className="group text-theme-dark-500 relative inline-flex w-full cursor-pointer items-center justify-center overflow-hidden bg-white px-6 py-3 text-base transition-all hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-70"
                        disabled={formAction.isExecuting}
                        type="submit">
                        {formAction.isExecuting ? "Sending..." : "Send Message"}
                    </button>
                </div>
            </form>
        </div>
    );
}
