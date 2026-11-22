export function GET() {
    return svg("#2563eb");
}

function svg(fill: string) {
    return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${fill}"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
    );
}
