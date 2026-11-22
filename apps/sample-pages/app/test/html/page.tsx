import Link from "next/link";

export default function ProxyHtmlTestPage() {
    return (
        <main data-testid="proxy-html-page">
            <h1>Proxy HTML fixture</h1>
            <div id="content-under-test">
                <p>Stable text inside the content div.</p>
                <p>
                    <strong>Nested value:</strong> alpha beta gamma
                </p>
            </div>

            <nav aria-label="fixture links">
                <Link id="relative-link" href="/test/html/next">
                    Relative link
                </Link>
                <a id="absolute-link" href="https://example.com/external">
                    Absolute link
                </a>
                <a id="mailto-link" href="mailto:fixture@example.com">
                    Mail link
                </a>
            </nav>

            <form id="relative-form" action="/test/api/echo" method="post">
                <button type="submit">Submit fixture form</button>
            </form>

            <link rel="stylesheet" href="/test/assets/proxy-fixture.css" />
            <img
                id="relative-image"
                alt="Proxy fixture"
                src="/test/assets/proxy-fixture.svg"
                srcSet="/test/assets/proxy-fixture-small.svg 1x, /test/assets/proxy-fixture-large.svg 2x"
            />
        </main>
    );
}
