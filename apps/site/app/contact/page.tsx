import { ContactForm } from "@/components/contact-form";
import { H2 } from "@/components/ui/h2";

export default function ContactPage() {
    return (
        <section className="mb-20 border-y border-white/20">
            <div className="mx-auto max-w-7xl px-6">
                <div className="border-x border-white/20 px-8 py-10 lg:p-20">
                    <div className="mx-auto mb-16 max-w-xl text-center">
                        <H2>Fill out contact form</H2>
                    </div>
                    <div className="flex flex-col justify-center gap-4 sm:flex-row">
                        <div
                            className="sm:w-7/12"
                            style={{
                                opacity: 1,
                                transform: "none",
                            }}>
                            <ContactForm />
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
