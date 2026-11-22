import { Button } from "@/components/ui/button";
import { H2 } from "@/components/ui/h2";
import { DOCS_URL } from "@/lib/links";
import { getAppUrl } from "@watchthatsite/ui/lib/utils";
import Link from "next/link";

export function CTA() {
    return (
        <section className="bg-theme-dark relative overflow-hidden border-t border-white/20 py-20">
            <div className="pointer-events-none absolute top-0 left-1/2 h-full w-full -translate-x-1/2">
                <img
                    className="h-full w-full"
                    alt=""
                    src="/gradients/shape-4.png"
                />
            </div>
            <div className="relative z-10 mx-auto max-w-2xl px-5">
                <H2 className="text-center">Start tracking now.</H2>
                <p className="mb-8 text-center text-white">
                    Start monitoring your favourite websites, social media (like
                    X, reddit, product hunt), career pages, product pages,
                    competitors, articles, journals, etc.
                </p>
                <div className="flex flex-col justify-center gap-6 sm:flex-row">
                    <Button asChild variant="primary">
                        <Link href={getAppUrl("login")} data-discover="true">
                            Get started
                        </Link>
                    </Button>
                    <Button
                        asChild
                        variant="outline"
                        className="font-sans hover:bg-white/50">
                        <Link href={DOCS_URL}>Read the docs</Link>
                    </Button>
                </div>
            </div>
        </section>
    );
}
