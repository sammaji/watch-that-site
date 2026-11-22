import Link from "next/link";

export default function NotFound() {
    return (
        <section className="relative mb-20 border-y border-white/20">
            <div className="relative mx-auto max-w-7xl px-6">
                <div className="border-x border-white/20">
                    <div className="relative z-20 mx-auto max-w-xl pt-20 pb-15 text-center lg:pt-30">
                        <h2 className="mb-3 text-3xl font-medium text-white lg:text-4xl">
                            Page Not Found!
                        </h2>
                        <p className="mb-5 text-base text-white/80 lg:mb-10">
                            It seems the page you were looking for could not be
                            found.
                        </p>
                        <Link
                            className="inline-flex shrink-0 items-center justify-center border border-white/40 bg-white/5 px-6 py-3 text-base font-normal text-white transition-all hover:bg-white/10"
                            href="/"
                            data-discover="true">
                            Back to Homepage
                        </Link>
                    </div>
                    <div className="relative z-10 -mt-30 lg:-mt-60">
                        <img alt="404 illustration" src="/gradients/404.png" />
                    </div>
                </div>
            </div>
        </section>
    );
}
