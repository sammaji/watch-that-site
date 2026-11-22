import { H2 } from "@/components/ui/h2";
import { H3 } from "@/components/ui/h3";

type Feature = {
    title: string;
    description: string;
};

const features: Feature[] = [
    {
        title: "Text diffing",
        description:
            "Watch a whole page, one element, or an API response. Every change shows you exactly what was added, removed, or rewritten, word by word, and skips timestamps, counters, and other text that changes on its own.",
    },
    {
        title: "Visual diffing",
        description:
            "Pictures, charts and layouts are compared as screenshots. WatchThatSite ignores layout shifts and ads, and points you to the regions that really changed, so a banner pushing the page down never counts as a change.",
    },

    {
        title: "Alerting",
        description:
            "Send change notifications to the channels you rely on, including Slack, Discord, Telegram, email, and webhooks. Get the context you need without constantly checking dashboards.",
    },
    {
        title: "Bring Your Own AI",
        description:
            "Connect your own provider keys for OpenAI, Anthropic, Gemini, and more. Keep control of AI usage, costs, and model choice while using WatchThatSite to analyze changes.",
    },
];

export default function FeaturesGrid() {
    return (
        <section className="mb-20 border-y border-white/20">
            <div className="mx-auto max-w-7xl px-6">
                <div className="border-x border-white/20 px-6 py-10 xl:px-12 xl:py-20">
                    <div className="mx-auto mb-16 max-w-147.5 text-center">
                        <H2>Features</H2>
                        <p className="text-base text-white/80">
                            Monitor the pages that matter, understand what
                            changed, and route alerts to the right place with
                            the AI providers your team already trusts.
                        </p>
                    </div>
                    {/* A true grid: cells in a row share a height, and the
                    1px gaps over a white/20 background draw the lines. */}
                    <div className="grid grid-cols-1 gap-px border border-white/20 bg-white/20 lg:grid-cols-2">
                        {features.map(f => (
                            <div
                                key={f.title}
                                className="bg-theme-dark p-5 transition duration-300 ease-in-out hover:bg-[#0d0d0d] lg:px-8 lg:py-12">
                                <H3>{f.title}</H3>
                                <p className="text-base text-white/80">
                                    {f.description}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}
