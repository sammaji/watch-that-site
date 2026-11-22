import { getVariant } from "@/lib/diff-state";

export const dynamic = "force-dynamic";

// A route handler (not a page) so each variant can set its own HTTP status
// and headers.

const OK_PARAGRAPHS = [
    "The city council met on Tuesday evening to discuss the new cycling lanes planned for the harbour district.",
    "Residents raised concerns about parking on the narrow streets near the fish market and the ferry terminal.",
    "Engineers presented three layouts, each separating bicycles from buses with a raised kerb.",
    "The preferred layout keeps loading bays for the market traders open before ten in the morning.",
    "Construction is expected to take eight months and will be carried out in four phases.",
    "Each phase closes one side of the road at a time so that buses can keep running on their usual routes.",
    "A public exhibition of the drawings will be held in the library foyer for the next three weeks.",
    "Comments can be left at the exhibition or sent to the council by post before the consultation closes.",
    "The council will publish a summary of the responses together with the final design later this year.",
    "Funding for the scheme comes from the regional transport budget and a grant for active travel.",
    "Local schools have asked for a safe crossing near the park, which the preferred layout includes.",
    "The harbour master confirmed that access for emergency vehicles will be kept during every phase.",
];

const OK_TEXT = OK_PARAGRAPHS.join(" ");

/** partialText returns about 5% of the ok page's text, cut at a word. */
function partialText() {
    const target = Math.round(OK_TEXT.length * 0.05);
    const cut = OK_TEXT.lastIndexOf(" ", target);
    return OK_TEXT.slice(0, cut > 0 ? cut : target);
}

const BASE_STYLE =
    "margin:0;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px";
const MAIN_STYLE = "box-sizing:border-box;width:960px;margin:0 auto;padding:24px";

function page({ title, body }: { title: string; body: string }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body style="${BASE_STYLE}">
<main data-fixture="status" style="${MAIN_STYLE}">
${body}
</main>
</body>
</html>`;
}

function html(body: string, status: number, headers: Record<string, string> = {}) {
    return new Response(body, {
        status,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            ...headers,
        },
    });
}

// Cloudflare's managed-challenge interstitial, trimmed to the parts the
// challenge detectors look at: the title, the #challenge-* ids, the
// cf_chl_opt script and the cf-mitigated response header.
const CHALLENGE_PAGE = `<!DOCTYPE html>
<html lang="en-US">
<head>
<title>Just a moment...</title>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta http-equiv="X-UA-Compatible" content="IE=Edge">
<meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box;margin:0;padding:0}html{line-height:1.15;-webkit-text-size-adjust:100%;color:#313131;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}body{display:flex;flex-direction:column;height:100vh;min-height:100vh}.main-content{margin:8rem auto;max-width:60rem;padding-left:1.5rem}.h2{font-size:1.5rem;font-weight:500;line-height:2.25rem}</style>
</head>
<body class="no-js">
<div class="main-wrapper" role="main">
<div class="main-content">
<h1 class="zone-name-title h1">localhost</h1>
<h2 id="challenge-running" class="h2">Checking if the site connection is secure</h2>
<noscript><div id="challenge-error-title"><div class="h2"><span class="icon-wrapper"></span>Enable JavaScript and cookies to continue</div></div></noscript>
<div id="challenge-body-text" class="core-msg spacer">localhost needs to review the security of your connection before proceeding.</div>
<form id="challenge-form" action="/test/diff/status?__cf_chl_f_tk=fixture" method="POST" enctype="application/x-www-form-urlencoded"></form>
</div>
</div>
<script>(function(){window._cf_chl_opt={cvId:'3',cZone:'localhost',cType:'managed',cRay:'8c0fixture'};}());</script>
<div class="footer" role="contentinfo"><div class="footer-inner"><div class="text-center" id="footer-text">Performance &amp; security by Cloudflare</div></div></div>
</body>
</html>`;

export async function GET() {
    const variant = getVariant("status");
    switch (variant) {
        case "503":
            return html(
                page({
                    title: "Service Unavailable",
                    body: "<h1>503 Service Unavailable</h1><p>The server is temporarily unable to handle the request.</p>",
                }),
                503,
                { "retry-after": "30" },
            );
        case "challenge":
            return html(CHALLENGE_PAGE, 403, {
                "cf-mitigated": "challenge",
                server: "cloudflare",
                "cf-ray": "8c0fixture-LHR",
            });
        case "empty":
            return html(
                page({
                    title: "Status fixture",
                    body: '<div id="app" style="height:400px"></div>',
                }),
                200,
            );
        case "partial":
            return html(
                page({
                    title: "Status fixture",
                    body: `<h1 style="font-size:32px;line-height:40px;margin:0 0 16px">Council news</h1><p>${partialText()}</p>`,
                }),
                200,
            );
        default:
            return html(
                page({
                    title: "Status fixture",
                    body:
                        '<h1 style="font-size:32px;line-height:40px;margin:0 0 16px">Council news</h1>' +
                        OK_PARAGRAPHS.map(p => `<p style="margin:0 0 12px">${p}</p>`).join("\n"),
                }),
                200,
            );
    }
}
