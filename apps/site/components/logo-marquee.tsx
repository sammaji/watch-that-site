type ClientLogo = { name: string; src: string };

const clientLogo: ClientLogo[] = [
    { name: "Shopify", src: "/client/shopify.svg" },
    { name: "Stripe", src: "/client/stripe.svg" },
    { name: "Webflow", src: "/client/webflow.svg" },
    { name: "Loom", src: "/client/loom.svg" },
    { name: "Notion", src: "/client/notion.svg" },
    { name: "Intercom", src: "/client/intercom.svg" },
    { name: "Linear", src: "/client/linear.svg" },
    { name: "Vercel", src: "/client/vercel.svg" },
];

export function LogoMarquee() {
    return (
        <section className="border-t border-white/20 py-16">
            <div className="mx-auto max-w-7xl px-6">
                <div>
                    <div className="mx-auto mb-16 flex w-69.5 items-center justify-center gap-10">
                        <span className="inline-block h-1 w-2 bg-white" />
                        <span className="font-mono text-white">Trusted by</span>
                        <span className="inline-block h-1 w-2 bg-white" />
                    </div>
                    <div className="inline-flex w-full flex-nowrap overflow-hidden mask-[linear-gradient(to_right,transparent_0,black_128px,black_calc(100%-200px),transparent_100%)]">
                        <ul className="animate-infinite-scroll flex items-center justify-center md:justify-start [&_img]:max-w-none [&_li]:mx-10">
                            {clientLogo.map(({ name, src }) => (
                                <li key={name}>
                                    <img
                                        className="h-6 brightness-0 invert"
                                        alt={name}
                                        src={src}
                                    />
                                </li>
                            ))}
                        </ul>
                        <ul
                            className="animate-infinite-scroll flex items-center justify-center md:justify-start [&_img]:max-w-none [&_li]:mx-10"
                            aria-hidden="true">
                            {clientLogo.map(({ name, src }) => (
                                <li key={name}>
                                    <img
                                        className="h-6 brightness-0 invert"
                                        alt={name}
                                        src={src}
                                    />
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        </section>
    );
}
