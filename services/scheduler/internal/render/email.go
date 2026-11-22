package render

import (
	"html"
	"strings"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
)

// Inline styles. Gmail strips <style>, <ins> and <del>, so every style is an
// attribute and additions/removals are plain spans.
const (
	styleAdded   = "background:#e6ffec;color:#1a7f37;"
	styleRemoved = "background:#ffebe9;color:#cf222e;text-decoration:line-through;"
	styleContext = "color:#656d76;"
	styleFont    = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"
	styleButton  = "display:inline-block;padding:8px 14px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;"
)

// EmailHTML renders the Change as an HTML email: inline styles only, tables
// for layout. It leads with the summary sentence, then the first MaxItems
// items as before → after (or, for a record without items, the first MaxOps
// lines of the diff), the crop image, and the action buttons.
func EmailHTML(r changerecord.Record, links Links) string {
	var b strings.Builder
	openEmail(&b, Subject(r))

	// The summary leads; the Monitor it is about sits under it.
	b.WriteString(`<tr><td style="padding:20px 24px 4px;">`)
	b.WriteString(`<div style="font-size:18px;font-weight:600;line-height:1.35;">`)
	b.WriteString(`<a href="` + attr(links.ViewURL(r)) + `" style="color:#1f2328;text-decoration:none;">` + esc(Summary(r)) + `</a>`)
	b.WriteString(`</div>`)
	b.WriteString(`<div style="margin:6px 0 0;font-size:12px;` + styleContext + `">`)
	b.WriteString(esc(monitorName(r)))
	if r.Monitor.URL != "" {
		b.WriteString(` · <a href="` + attr(safeHref(r.Monitor.URL)) + `" style="color:#656d76;">` + esc(truncate(r.Monitor.URL, 80)) + `</a>`)
	}
	b.WriteString(`</div></td></tr>`)

	if note := NoteLine(r); note != "" {
		b.WriteString(`<tr><td style="padding:4px 24px 8px;font-size:13px;` + styleContext + `">` + esc(note) + `</td></tr>`)
	}

	if its := items(r); len(its.Lines) > 0 {
		b.WriteString(`<tr><td style="padding:6px 24px;">`)
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #d0d7de;border-radius:6px;font-size:14px;line-height:1.5;">`)
		for i, l := range its.Lines {
			writeEmailItem(&b, l, i > 0)
		}
		b.WriteString(`</table></td></tr>`)
		if more := its.More(); more > 0 {
			b.WriteString(`<tr><td style="padding:6px 24px;font-size:14px;"><a href="` + attr(links.ViewURL(r)) + `" style="color:#0969da;">` + esc(moreItemsText(more)) + `</a></td></tr>`)
		}
	} else {
		writeEmailDiff(&b, r, links)
	}

	if img := links.Image(); img != "" {
		b.WriteString(`<tr><td style="padding:8px 24px;"><a href="` + attr(links.ViewURL(r)) + `">`)
		b.WriteString(`<img src="` + attr(img) + `" width="552" alt="Before and after" style="display:block;width:100%;max-width:552px;height:auto;border:1px solid #d0d7de;border-radius:6px;">`)
		b.WriteString(`</a></td></tr>`)
	}

	writeEmailButtons(&b, [][2]string{
		{"View change", links.ViewURL(r)},
		{"This was Noise", links.NoiseURL(r)},
		{"Pause", links.PauseURL(r)},
	})
	closeEmail(&b, `You get this because you watch `+esc(monitorName(r))+` on WatchThatSite. <a href="`+attr(links.MonitorURL(r.Monitor.ID))+`" style="color:#656d76;">Monitor settings</a>`)
	return b.String()
}

// writeEmailItem writes one item as two rows: its title, then before → after.
func writeEmailItem(b *strings.Builder, l itemLine, rule bool) {
	border := ""
	if rule {
		border = "border-top:1px solid #d0d7de;"
	}
	b.WriteString(`<tr><td style="padding:8px 10px 2px;font-weight:600;` + border + `">` + esc(l.Title))
	if l.Section != "" {
		b.WriteString(` <span style="font-weight:400;` + styleContext + `">· ` + esc(l.Section) + `</span>`)
	}
	b.WriteString(`</td></tr><tr><td style="padding:0 10px 8px;">`)
	switch {
	case l.Before != "" && l.After != "":
		b.WriteString(span(styleRemoved, l.Before) + ` → ` + span(styleAdded, l.After))
	case l.After != "":
		b.WriteString(span(styleAdded, l.After))
	case l.Before != "":
		b.WriteString(span(styleRemoved, l.Before))
	}
	b.WriteString(`</td></tr>`)
}

// writeEmailDiff writes the first lines of the text diff, for a record
// without items.
func writeEmailDiff(b *strings.Builder, r changerecord.Record, links Links) {
	cs := changes(r)
	// Adjacent changes share one box.
	for i, l := range cs.Lines {
		if i == 0 || !l.Adjacent {
			if i > 0 {
				b.WriteString(`</table></td></tr>`)
			}
			b.WriteString(`<tr><td style="padding:6px 24px;">`)
			b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #d0d7de;border-radius:6px;font-size:14px;line-height:1.5;">`)
		}
		writeEmailChange(b, l)
	}
	if len(cs.Lines) > 0 {
		b.WriteString(`</table></td></tr>`)
	}
	if more := cs.More(); more > 0 {
		b.WriteString(`<tr><td style="padding:6px 24px;font-size:14px;"><a href="` + attr(links.ViewURL(r)) + `" style="color:#0969da;">` + esc(moreText(more)) + `</a></td></tr>`)
	}
}

// writeEmailChange writes one change as table rows: context, change,
// context.
func writeEmailChange(b *strings.Builder, l changeLine) {
	if l.Before != "" {
		b.WriteString(`<tr><td style="padding:6px 10px 0;` + styleContext + `">` + esc(l.Before) + `</td></tr>`)
	}
	b.WriteString(`<tr><td style="padding:6px 10px;">`)
	switch l.Kind {
	case lineAdd:
		b.WriteString(span(styleAdded, l.Segs[0].Text))
	case lineRemove:
		b.WriteString(span(styleRemoved, l.Segs[0].Text))
	case lineMove:
		b.WriteString(`<span style="` + styleContext + `">↪ moved</span> ` + esc(l.Segs[0].Text))
	default:
		if l.Whole {
			before, after := l.sides()
			b.WriteString(span(styleRemoved, before) + `<br>` + span(styleAdded, after))
			break
		}
		for _, s := range l.Segs {
			writeSeg(b, s)
		}
	}
	b.WriteString(`</td></tr>`)
	if l.After != "" {
		b.WriteString(`<tr><td style="padding:0 10px 6px;` + styleContext + `">` + esc(l.After) + `</td></tr>`)
	}
}

func writeSeg(b *strings.Builder, s segment) {
	switch s.Kind {
	case segAdd:
		b.WriteString(span(styleAdded, s.Text))
	case segDel:
		b.WriteString(span(styleRemoved, s.Text))
	default:
		b.WriteString(esc(s.Text))
	}
}

func span(style, text string) string {
	return `<span style="` + style + `">` + esc(text) + `</span>`
}

// openEmail writes the document shell and opens the 600 px card table.
func openEmail(b *strings.Builder, title string) {
	b.WriteString(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>`)
	b.WriteString(esc(title))
	b.WriteString(`</title></head><body style="margin:0;padding:0;background:#f6f8fa;">`)
	b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fa;"><tr><td align="center" style="padding:24px 12px;">`)
	b.WriteString(`<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #d0d7de;border-radius:8px;color:#1f2328;` + styleFont + `">`)
}

// closeEmail closes the card with a footer line (already HTML).
func closeEmail(b *strings.Builder, footerHTML string) {
	b.WriteString(`<tr><td style="padding:12px 24px 20px;font-size:12px;border-top:1px solid #d0d7de;` + styleContext + `">` + footerHTML + `</td></tr>`)
	b.WriteString(`</table></td></tr></table></body></html>`)
}

// writeEmailButtons writes link buttons; the first is primary.
func writeEmailButtons(b *strings.Builder, buttons [][2]string) {
	b.WriteString(`<tr><td style="padding:16px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`)
	for i, btn := range buttons {
		style := styleButton + "background:#f6f8fa;color:#1f2328;border:1px solid #d0d7de;"
		if i == 0 {
			style = styleButton + "background:#1f883d;color:#ffffff;border:1px solid #1f883d;"
		}
		b.WriteString(`<td style="padding:0 8px 8px 0;"><a href="` + attr(btn[1]) + `" style="` + style + `">` + esc(btn[0]) + `</a></td>`)
	}
	b.WriteString(`</tr></table></td></tr>`)
}

// EmailText renders the plain-text part.
func EmailText(r changerecord.Record, links Links) string {
	var b strings.Builder
	b.WriteString(Summary(r) + "\n")
	b.WriteString(monitorName(r))
	if r.Monitor.URL != "" {
		b.WriteString(" — " + r.Monitor.URL)
	}
	b.WriteString("\n")
	if note := NoteLine(r); note != "" {
		b.WriteString("\n" + note + "\n")
	}
	if its := items(r); len(its.Lines) > 0 {
		b.WriteString("\n")
		for _, l := range its.Lines {
			b.WriteString("- " + l.head() + "\n")
			if t := l.text(); t != "" {
				b.WriteString("  " + t + "\n")
			}
		}
		if more := its.More(); more > 0 {
			b.WriteString("\n" + moreItemsText(more) + ": " + links.ViewURL(r) + "\n")
		}
	} else {
		cs := changes(r)
		if len(cs.Lines) > 0 {
			text, _ := diffText(cs.Lines, 1<<20)
			b.WriteString("\n" + text + "\n")
		}
		if more := cs.More(); more > 0 {
			b.WriteString("\n" + moreText(more) + ": " + links.ViewURL(r) + "\n")
		}
	}
	if img := links.Image(); img != "" {
		b.WriteString("\nBefore and after: " + img + "\n")
	}
	b.WriteString("\nView change: " + links.ViewURL(r) + "\n")
	b.WriteString("This was noise: " + links.NoiseURL(r) + "\n")
	b.WriteString("Pause this Monitor: " + links.PauseURL(r) + "\n")
	return b.String()
}

func esc(s string) string { return html.EscapeString(s) }

// safeHref returns u when it is an http(s) URL, else "#", so a stored URL
// can never become a javascript: link.
func safeHref(u string) string {
	l := strings.ToLower(strings.TrimSpace(u))
	if strings.HasPrefix(l, "https://") || strings.HasPrefix(l, "http://") {
		return strings.TrimSpace(u)
	}
	return "#"
}
func attr(s string) string { return html.EscapeString(s) }
