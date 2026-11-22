package render

import (
	"strings"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
)

// Telegram message limits.
const (
	TelegramMaxTextRunes    = 4096
	TelegramMaxCaptionRunes = 1024
)

// Telegram renders an HTML-parse-mode message: the summary in <b>, the
// Monitor under it, then the items with what was removed in <s> (or, for a
// record without items, the diff lines), plus links. When an image exists it
// is sent as a photo with a short caption; the text follows only when there
// are items or text changes to show.
func Telegram(r changerecord.Record, links Links) notify.TelegramBody {
	head := "<b>" + esc(Summary(r)) + "</b>\n" + esc(truncate(monitorName(r), 100))
	why := ""
	if w := NoteLine(r); w != "" {
		why = "<i>" + esc(w) + "</i>"
	}
	actions := tgLink("View change", links.ViewURL(r)) + " · " +
		tgLink("This was Noise", links.NoiseURL(r)) + " · " +
		tgLink("Pause", links.PauseURL(r))

	its, cs := items(r), changeSet{}
	if len(its.Lines) == 0 {
		cs = changes(r)
	}
	var body strings.Builder
	body.WriteString(head)
	if why != "" {
		body.WriteString("\n" + why)
	}
	// Reserve room for the more link and the actions.
	reserve := runes(actions) + 120 + runes(links.ViewURL(r))
	shown := 0
	for _, l := range its.Lines {
		block := "\n\n" + tgItem(l)
		if runes(body.String())+runes(block)+reserve > TelegramMaxTextRunes {
			break
		}
		body.WriteString(block)
		shown++
	}
	if more := its.Total - shown; more > 0 {
		body.WriteString("\n\n" + tgLink(moreItemsText(more), links.ViewURL(r)))
	}
	shown = 0
	for _, l := range cs.Lines {
		sep := "\n\n"
		if l.Adjacent && shown > 0 {
			sep = "\n"
		}
		block := sep + tgChange(l)
		if runes(body.String())+runes(block)+reserve > TelegramMaxTextRunes {
			break
		}
		body.WriteString(block)
		shown++
	}
	if more := cs.Total - shown; more > 0 {
		body.WriteString("\n\n" + tgLink(moreText(more), links.ViewURL(r)))
	}
	body.WriteString("\n\n" + actions)

	out := notify.TelegramBody{Text: body.String()}
	if img := links.Image(); img != "" {
		out.PhotoURL = img
		out.Caption = tgCaption(monitorName(r), Summary(r), NoteLine(r), actions)
		if len(its.Lines) == 0 && len(cs.Lines) == 0 {
			// The caption already says everything.
			out.Text = ""
		}
	}
	return out
}

// tgCaption fits the summary, the Monitor, the note line and the actions into
// 1,024 characters (counted on the raw HTML, which is never shorter than
// what Telegram counts), trimming the note line first and then the summary.
func tgCaption(name, headline, why, actions string) string {
	name = truncate(name, 100)
	build := func(hl, w string) string {
		c := "<b>" + esc(hl) + "</b>\n" + esc(name)
		if w != "" {
			c += "\n<i>" + esc(w) + "</i>"
		}
		return c + "\n\n" + actions
	}
	hl, w := headline, why
	for {
		c := build(hl, w)
		over := runes(c) - TelegramMaxCaptionRunes
		switch {
		case over <= 0:
			return c
		case w != "":
			if n := runes(w) - over - 1; n > 10 {
				w = truncate(w, n)
			} else {
				w = ""
			}
		case runes(hl) > 20:
			hl = truncate(hl, max(runes(hl)-over-1, 20))
		default:
			return truncate(c, TelegramMaxCaptionRunes)
		}
	}
}

func tgItem(l itemLine) string {
	s := "<b>" + esc(l.head()) + "</b>"
	switch {
	case l.Before != "" && l.After != "":
		s += "\n<s>" + esc(l.Before) + "</s> → " + esc(l.After)
	case l.After != "":
		s += "\n" + esc(l.After)
	case l.Before != "":
		s += "\n<s>" + esc(l.Before) + "</s>"
	}
	return s
}

func tgChange(l changeLine) string {
	var b strings.Builder
	if l.Before != "" {
		b.WriteString("<i>" + esc(l.Before) + "</i>\n")
	}
	switch l.Kind {
	case lineAdd:
		b.WriteString("<b>" + esc(l.Segs[0].Text) + "</b>")
	case lineRemove:
		b.WriteString("<s>" + esc(l.Segs[0].Text) + "</s>")
	case lineMove:
		b.WriteString("↪ moved: " + esc(l.Segs[0].Text))
	default:
		if l.Whole {
			before, after := l.sides()
			b.WriteString("<s>" + esc(before) + "</s>\n<b>" + esc(after) + "</b>")
			break
		}
		for _, s := range l.Segs {
			b.WriteString(tgSeg(s))
		}
	}
	if l.After != "" {
		b.WriteString("\n<i>" + esc(l.After) + "</i>")
	}
	return b.String()
}

func tgSeg(s segment) string {
	switch s.Kind {
	case segAdd:
		return "<b>" + esc(s.Text) + "</b>"
	case segDel:
		return "<s>" + esc(s.Text) + "</s>"
	default:
		return esc(s.Text)
	}
}

func tgLink(label, url string) string {
	return `<a href="` + attr(url) + `">` + esc(label) + `</a>`
}
