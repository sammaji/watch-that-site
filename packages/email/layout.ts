/**
 * The layout every account email shares. Email clients drop <style> blocks
 * and recolour links, so every style is inline and the layout is tables. The
 * button is a dark fill with its text colour set on the link itself, which
 * keeps it legible in every client.
 */

export type EmailParts = {
    /** The inbox preview line. */
    preview: string;
    heading: string;
    /** Paragraphs of plain text, escaped here. */
    body: string[];
    button: { label: string; url: string };
    /** Small print under the button. */
    note: string;
};

export type Email = { subject: string; html: string; text: string };

const esc = (s: string) =>
    s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const FONT =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export function render(subject: string, p: EmailParts): Email {
    const url = esc(p.button.url);
    const paragraphs = p.body
        .map(
            line =>
                `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#1f2328;">${esc(line)}</p>`,
        )
        .join("");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f8fa;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(p.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;font-family:${FONT};">
<tr><td style="padding:0 4px 16px;font-size:15px;font-weight:600;color:#1f2328;">WatchThatSite</td></tr>
<tr><td style="background:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:28px 28px 24px;">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:#1f2328;">${esc(p.heading)}</h1>
${paragraphs}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 20px;">
<tr><td style="background:#1f2328;border-radius:6px;">
<a href="${url}" style="display:inline-block;padding:11px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(p.button.label)}</a>
</td></tr>
</table>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#656d76;">${esc(p.note)}</p>
<p style="margin:0;padding-top:16px;border-top:1px solid #eaeef2;font-size:12px;line-height:1.5;color:#656d76;">Button not working? Paste this link into your browser:<br><a href="${url}" style="color:#656d76;word-break:break-all;">${url}</a></p>
</td></tr>
<tr><td style="padding:16px 4px 0;font-size:12px;color:#8c959f;">WatchThatSite watches web pages and tells you when something you care about changes.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
    const text = [
        p.heading,
        "",
        ...p.body.flatMap(line => [line, ""]),
        `${p.button.label}: ${p.button.url}`,
        "",
        p.note,
        "",
        "-- WatchThatSite",
    ].join("\n");
    return { subject, html, text };
}
