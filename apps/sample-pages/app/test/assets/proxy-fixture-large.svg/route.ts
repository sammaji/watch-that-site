export function GET() {
    return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#dc2626"/></svg>',
        { headers: { "content-type": "image/svg+xml" } },
    );
}
