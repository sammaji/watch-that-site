import { FAQ } from "@/components/faq";
import FeaturesGrid from "@/components/features-grid";
import { LogoMarquee } from "@/components/logo-marquee";
import { Button } from "@/components/ui/button";
import { H1 } from "@/components/ui/h1";
import { getAppUrl } from "@watchthatsite/ui/lib/utils";

export default function Home() {
    return (
        <div>
            <section className="relative overflow-hidden border-y border-white/20">
                <div className="pointer-events-none absolute left-1/2 h-full w-full -translate-x-1/2">
                    <img
                        className="h-full w-full"
                        alt=""
                        src="/gradients/gradient.png"
                    />
                </div>
                <div className="relative z-20 mx-auto max-w-7xl px-6">
                    <div className="border-x border-white/20 pt-6 xl:py-30">
                        <div className="mx-auto max-w-md px-4 py-14 lg:max-w-2xl xl:max-w-4xl">
                            <H1>
                                Track changes across any website. Respond
                                faster.
                            </H1>
                            <p className="mx-auto mb-8 max-w-lg text-center text-base text-white/80 xl:mb-14">
                                WatchThatSite lets you track changes on any
                                website.
                            </p>
                            <div className="flex flex-wrap items-center justify-center gap-3">
                                <Button
                                    href={getAppUrl("signup")}
                                    variant="primary"
                                    size="nav">
                                    Get started
                                </Button>
                                <Button
                                    href={getAppUrl("login")}
                                    variant="outline"
                                    size="nav">
                                    Login
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
            <LogoMarquee />
            <FeaturesGrid />
            <section className="mb-20 border-y border-white/20">
                <div className="mx-auto max-w-7xl px-6">
                    <div className="py-20">
                        <div className="mx-auto mb-16 text-center lg:max-w-lg">
                            <h2 className="mb-6 text-3xl font-medium text-white sm:text-4xl">
                                Hear From Our Community
                            </h2>
                            <p className="text-base text-white/80">
                                Founders, marketers and engineers use
                                WatchThatSite to hear about the changes that
                                matter, and nothing else.
                            </p>
                        </div>
                        <div className="mb-6 inline-flex w-full flex-nowrap overflow-hidden mask-[linear-gradient(to_right,transparent_0,black_128px,black_calc(100%-200px),transparent_100%)]">
                            <ul className="animate-scroll-left flex items-center justify-center md:justify-start [&_li]:mx-3">
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Lydia Carter"
                                                src="/avatars/avatar-1.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Lydia Carter
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @lyd_carter21
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            Using this AI tool has transformed
                                            the way I approach my marketing
                                            campaigns. Efficiency has
                                            skyrocketed!
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Marcus Thompson"
                                                src="/avatars/avatar-2.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Marcus Thompson
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @m_thompson
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            The best investment I&apos;ve made
                                            for my business. The AI generates
                                            content that truly resonates with my
                                            audience.
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Sarah Mitchell"
                                                src="/avatars/avatar-3.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Sarah Mitchell
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @sarah_m
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            I was skeptical at first, but this
                                            tool exceeded all my expectations.
                                            My productivity has doubled!
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="James Wilson"
                                                src="/avatars/avatar-4.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                James Wilson
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @j_wilson
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            This AI tool is a game-changer for
                                            content creators. Highly recommend
                                            for anyone looking to streamline
                                            their workflow.
                                        </p>
                                    </div>
                                </li>
                            </ul>
                            <ul
                                className="animate-scroll-left flex items-center justify-center md:justify-start [&_li]:mx-3"
                                aria-hidden="true">
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Lydia Carter"
                                                src="/avatars/avatar-1.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Lydia Carter
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @lyd_carter21
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            Using this AI tool has transformed
                                            the way I approach my marketing
                                            campaigns. Efficiency has
                                            skyrocketed!
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Marcus Thompson"
                                                src="/avatars/avatar-2.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Marcus Thompson
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @m_thompson
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            The best investment I&apos;ve made
                                            for my business. The AI generates
                                            content that truly resonates with my
                                            audience.
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Sarah Mitchell"
                                                src="/avatars/avatar-3.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Sarah Mitchell
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @sarah_m
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            I was skeptical at first, but this
                                            tool exceeded all my expectations.
                                            My productivity has doubled!
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="James Wilson"
                                                src="/avatars/avatar-4.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                James Wilson
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @j_wilson
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            This AI tool is a game-changer for
                                            content creators. Highly recommend
                                            for anyone looking to streamline
                                            their workflow.
                                        </p>
                                    </div>
                                </li>
                            </ul>
                        </div>
                        <div className="inline-flex w-full flex-nowrap overflow-hidden mask-[linear-gradient(to_right,transparent_0,black_128px,black_calc(100%-200px),transparent_100%)]">
                            <ul className="animate-scroll-right flex items-center justify-center md:justify-start [&_li]:mx-3">
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Emily Davis"
                                                src="/avatars/avatar-3.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Emily Davis
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @emily_d
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            Incredible tool that has saved me
                                            countless hours. The AI suggestions
                                            are spot-on and very helpful.
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="David Brown"
                                                src="/avatars/avatar-4.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                David Brown
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @d_brown
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            A must-have for anyone in digital
                                            marketing. The results speak for
                                            themselves!
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Jessica Taylor"
                                                src="/avatars/avatar-1.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Jessica Taylor
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @jess_t
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            I love how intuitive this tool is.
                                            It has completely changed my content
                                            creation process.
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Michael Johnson"
                                                src="/avatars/avatar-2.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Michael Johnson
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @mike_j
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            Fantastic AI tool that delivers
                                            consistent results. My team
                                            productivity has increased
                                            significantly.
                                        </p>
                                    </div>
                                </li>
                            </ul>
                            <ul
                                className="animate-scroll-right flex items-center justify-center md:justify-start [&_li]:mx-3"
                                aria-hidden="true">
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Emily Davis"
                                                src="/avatars/avatar-3.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Emily Davis
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @emily_d
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            Incredible tool that has saved me
                                            countless hours. The AI suggestions
                                            are spot-on and very helpful.
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="David Brown"
                                                src="/avatars/avatar-4.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                David Brown
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @d_brown
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            A must-have for anyone in digital
                                            marketing. The results speak for
                                            themselves!
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Jessica Taylor"
                                                src="/avatars/avatar-1.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Jessica Taylor
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @jess_t
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            I love how intuitive this tool is.
                                            It has completely changed my content
                                            creation process.
                                        </p>
                                    </div>
                                </li>
                                <li className="min-w-105 border border-white/10 bg-white/3 p-6">
                                    <div className="mb-2 flex items-center gap-3">
                                        <div>
                                            <img
                                                className="size-12 rounded-full"
                                                alt="Michael Johnson"
                                                src="/avatars/avatar-2.png"
                                            />
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-medium text-white">
                                                Michael Johnson
                                            </h4>
                                            <span className="text-base text-zinc-400">
                                                @mike_j
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-base text-zinc-400">
                                            Fantastic AI tool that delivers
                                            consistent results. My team
                                            productivity has increased
                                            significantly.
                                        </p>
                                    </div>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>
            </section>
            <FAQ />
        </div>
    );
}
