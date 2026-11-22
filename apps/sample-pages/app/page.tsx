import Link from "next/link";

export default function IndexPage() {
    return (
        <main className="mx-auto max-w-xl space-y-4 p-8">
            <h1 className="text-2xl font-semibold">Sample Pages</h1>
            <ul className="list-disc space-y-2 pl-5">
                <li>
                    <Link className="underline" href="/blog">
                        Blog (text-diff sample)
                    </Link>
                </li>
                <li>
                    <Link className="underline" href="/shop">
                        Shop (ecommerce sample)
                    </Link>
                </li>
                <li>
                    <Link className="underline" href="/careers">
                        Careers (listings sample)
                    </Link>
                </li>
                <li>
                    <Link className="underline" href="/finances">
                        Finances (table sample)
                    </Link>
                </li>
            </ul>
        </main>
    );
}
