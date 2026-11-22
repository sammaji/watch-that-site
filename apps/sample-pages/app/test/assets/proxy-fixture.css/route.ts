export function GET() {
    return new Response(
        `.fixture-bg { background-image: url("/test/assets/proxy-fixture.svg"); }\n` +
            `.fixture-cursor { cursor: url('../assets/proxy-fixture-small.svg'), auto; }\n` +
            `.fixture-data { background-image: url(data:image/png;base64,abc); }\n`,
        { headers: { "content-type": "text/css; charset=utf-8" } },
    );
}
