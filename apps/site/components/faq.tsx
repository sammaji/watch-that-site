"use client";

import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { H2 } from "@/components/ui/h2";
import { cn } from "@watchthatsite/ui/lib/utils";

const faqs = [
    {
        question: "What is WatchThatSite?",
        answer: (
            <>
                WatchThatSite watches web pages and tells you when something you
                care about changes.
                <br />
                <br />
                You describe what matters in plain words. An AI agent compares
                each new version of the page with the last one and decides
                whether the difference is a change you asked about.
            </>
        ),
    },
    {
        question: "How does website change monitoring work?",
        answer: (
            <>
                You add a URL, write what to watch for and what to ignore, and
                pick how often to check. WatchThatSite loads the page on that
                schedule and compares it with the previous version.
                <br />
                <br />
                When they differ, the agent reads your instructions and the
                differences, and you are notified only when the change is one
                you asked about, with a summary and the before and after.
            </>
        ),
    },
    {
        question: "Is WatchThatSite free?",
        answer: (
            <>
                Yes. WatchThatSite is free to use: there are no plans and
                nothing to pay us.
                <br />
                <br />
                The agent runs on a model you bring. You add your own API key
                and your model provider bills you for what your monitors use.
            </>
        ),
    },
    {
        question: "What types of content can I monitor?",
        answer: "You can monitor public webpages for text, content, and layout changes across product pages, docs, competitor sites, listings, social media (like X, reddit, linkedin, product hunt) and more. Pages behind a sign-in or a filter work too: the agent records the steps to get there and replays them before each check.",
    },
    {
        question: "Which AI models can I use?",
        answer: (
            <>
                Any model you have a key for, through one of two kinds of
                connection: OpenAI-compatible or Anthropic-compatible.
                <br />
                <br />
                That covers OpenAI and Anthropic directly, and gateways such as
                OpenRouter by setting a base URL. Your key is encrypted before
                it is stored.
            </>
        ),
    },
];

export function FAQ() {
    const [openIndex, setOpenIndex] = useState<number | null>(0);

    return (
        <section className="mb-20 border-y border-white/20">
            <div className="mx-auto max-w-7xl px-6">
                <div className="border-x border-white/20 p-5 lg:p-20">
                    <div className="grid grid-cols-1 lg:grid-cols-2 lg:gap-28">
                        <div className="mb-10 lg:mb-0">
                            <H2>Frequently Asked Questions</H2>
                            <p className="mb-6 text-base text-white/80">
                                Find answers to common questions about
                                WatchThatSite.
                            </p>
                        </div>
                        <div>
                            {faqs.map((faq, index) => {
                                const isOpen = openIndex === index;
                                const contentId = `faq-content-${index}`;
                                return (
                                    <div
                                        key={faq.question}
                                        className="border-b border-white/10 py-6">
                                        <button
                                            type="button"
                                            aria-expanded={isOpen}
                                            aria-controls={contentId}
                                            className={cn(
                                                buttonVariants({
                                                    variant: "plain",
                                                    size: "unset",
                                                }),
                                                "flex w-full items-center justify-between gap-4 text-left",
                                            )}
                                            onClick={() =>
                                                setOpenIndex(
                                                    isOpen ? null : index,
                                                )
                                            }>
                                            <h3 className="text-lg tracking-[-0.18px] text-zinc-50">
                                                {faq.question}
                                            </h3>
                                            <span
                                                className={cn(
                                                    "text-white/80 transition-transform",
                                                    isOpen && "rotate-180",
                                                )}>
                                                <svg
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    width={24}
                                                    height={24}
                                                    viewBox="0 0 24 24"
                                                    fill="none">
                                                    <path
                                                        d="M5.75 9.625L12 15.875L18.25 9.625"
                                                        stroke="currentColor"
                                                        strokeWidth="1.5"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    />
                                                </svg>
                                            </span>
                                        </button>
                                        <div
                                            id={contentId}
                                            hidden={!isOpen}
                                            className="pt-4 text-base leading-7 text-white/70">
                                            {faq.answer}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
