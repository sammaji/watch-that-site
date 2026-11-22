import Link from "next/link";

const FEATURED = [
    {
        href: "/test/careers",
        title: "Careers",
        hint: "Open roles with a department filter. New product manager roles appear every 30 seconds (?refresh_interval=<ms> to change it).",
    },
    {
        href: "/test/account",
        title: "Account (sign-in)",
        hint: "A billing page behind a sign-in, for Pre-scraping. Email owner@northwind.test, password northwind-demo.",
    },
];

const OTHERS = [
    { href: "/blog", title: "Blog (text-diff sample)" },
    { href: "/shop", title: "Shop (ecommerce sample)" },
    { href: "/careers", title: "Careers (listings sample)" },
    { href: "/finances", title: "Finances (table sample)" },
];

export default function IndexPage() {
    return (
        <main className="mx-auto max-w-xl space-y-8 p-8">
            <div className="space-y-2">
                <h1 className="text-2xl font-semibold">Sample pages</h1>
                <p className="text-sm text-neutral-600">
                    Pages to try WatchThatSite on.
                </p>
            </div>
            <ul className="space-y-4">
                {FEATURED.map(p => (
                    <li key={p.href}>
                        <Link className="font-medium underline" href={p.href}>
                            {p.title}
                        </Link>
                        <p className="text-sm text-neutral-600">{p.hint}</p>
                    </li>
                ))}
            </ul>
            <div className="space-y-2">
                <h2 className="text-sm font-medium text-neutral-500">
                    More samples
                </h2>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                    {OTHERS.map(p => (
                        <li key={p.href}>
                            <Link className="underline" href={p.href}>
                                {p.title}
                            </Link>
                        </li>
                    ))}
                </ul>
            </div>
        </main>
    );
}
