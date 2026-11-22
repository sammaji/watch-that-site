export function GET() {
    return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#16a34a"/></svg>',
        { headers: { "content-type": "image/svg+xml" } },
    );
}
