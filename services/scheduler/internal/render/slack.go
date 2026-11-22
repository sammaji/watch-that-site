package render

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
)

// Slack Block Kit limits.
const (
	SlackMaxTextRunes   = 3000
	SlackMaxBlocks      = 50
	slackHeaderMaxRunes = 150
	slackButtonMaxRunes = 75
)

type slackText struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	Emoji *bool  `json:"emoji,omitempty"`
}

type slackElement struct {
	Type     string     `json:"type"`
	Text     *slackText `json:"text,omitempty"`
	ActionID string     `json:"action_id,omitempty"`
	URL      string     `json:"url,omitempty"`
	Style    string     `json:"style,omitempty"`
}

type slackBlock struct {
	Type     string         `json:"type"`
	Text     *slackText     `json:"text,omitempty"`
	Elements []slackElement `json:"elements,omitempty"`
	ImageURL string         `json:"image_url,omitempty"`
	AltText  string         `json:"alt_text,omitempty"`
}

type slackMessage struct {
	Text   string       `json:"text"`
	Blocks []slackBlock `json:"blocks"`
}

// Slack renders a Block Kit message {text, blocks}: the summary as the
// header, the Monitor, the items as before → after (or, for a record without
// items, the diff as +/- lines in a code block), the crop image and link
// buttons. Every text object stays within 3,000 characters and the message
// within 50 blocks.
func Slack(r changerecord.Record, links Links) (json.RawMessage, error) {
	msg := slackMessage{Text: Subject(r)}
	msg.Blocks = append(msg.Blocks, slackHeader(Summary(r)))

	meta := "*" + slackLink(safeHref(r.Monitor.URL), monitorName(r)) + "*"
	if note := NoteLine(r); note != "" {
		meta += "\n" + slackEscape(note)
	}
	msg.Blocks = append(msg.Blocks, slackSection(meta))

	if its := items(r); len(its.Lines) > 0 {
		text, shown := slackItems(its.Lines)
		if shown > 0 {
			msg.Blocks = append(msg.Blocks, slackSection(text))
		}
		if more := its.Total - shown; more > 0 {
			msg.Blocks = append(msg.Blocks, slackSection(slackLink(links.ViewURL(r), moreItemsText(more))))
		}
	} else {
		cs := changes(r)
		shown := 0
		if len(cs.Lines) > 0 {
			var code string
			code, shown = slackCodeBlock(cs.Lines)
			if shown > 0 {
				msg.Blocks = append(msg.Blocks, slackSection(code))
			}
		}
		if more := cs.Total - shown; more > 0 {
			msg.Blocks = append(msg.Blocks, slackSection(slackLink(links.ViewURL(r), moreText(more))))
		}
	}
	if img := links.Image(); img != "" {
		msg.Blocks = append(msg.Blocks, slackBlock{Type: "image", ImageURL: img, AltText: "Before and after"})
	}
	msg.Blocks = append(msg.Blocks, slackActions(
		[3]string{"View change", links.ViewURL(r), "view_change"},
		[3]string{"This was Noise", links.NoiseURL(r), "mark_noise"},
		[3]string{"Pause", links.PauseURL(r), "pause"},
	))
	return json.Marshal(msg)
}

// slackItems renders items as mrkdwn, one per paragraph, within the text
// limit. It reports how many fit.
func slackItems(lines []itemLine) (string, int) {
	var b strings.Builder
	n := 0
	for _, l := range lines {
		// "~" would end the strikethrough early and "*" the bold title.
		clean := strings.NewReplacer("~", "∼", "*", "∗").Replace
		block := "*" + slackEscape(clean(l.head())) + "*"
		switch {
		case l.Before != "" && l.After != "":
			block += "\n~" + slackEscape(clean(l.Before)) + "~ → " + slackEscape(l.After)
		case l.After != "":
			block += "\n" + slackEscape(l.After)
		case l.Before != "":
			block += "\n~" + slackEscape(clean(l.Before)) + "~"
		}
		if n > 0 {
			block = "\n\n" + block
		}
		if utf8.RuneCountInString(b.String())+utf8.RuneCountInString(block) > SlackMaxTextRunes {
			break
		}
		b.WriteString(block)
		n++
	}
	return b.String(), n
}

// slackCodeBlock renders the diff inside ``` fences within the text limit,
// reporting how many changes fit.
func slackCodeBlock(lines []changeLine) (string, int) {
	for budget := SlackMaxTextRunes - 20; budget > 0; budget -= 250 {
		text, n := diffText(lines, budget)
		code := "```\n" + slackEscape(noFence(text)) + "\n```"
		if utf8.RuneCountInString(code) <= SlackMaxTextRunes {
			return code, n
		}
	}
	return "", 0
}

func slackHeader(text string) slackBlock {
	emoji := true
	return slackBlock{Type: "header", Text: &slackText{Type: "plain_text", Text: truncate(text, slackHeaderMaxRunes), Emoji: &emoji}}
}

func slackSection(mrkdwn string) slackBlock {
	return slackBlock{Type: "section", Text: &slackText{Type: "mrkdwn", Text: truncateMrkdwn(mrkdwn, SlackMaxTextRunes)}}
}

// slackActions renders link buttons from {label, url, action_id}; the first
// is primary.
func slackActions(buttons ...[3]string) slackBlock {
	b := slackBlock{Type: "actions"}
	for i, btn := range buttons {
		el := slackElement{
			Type:     "button",
			Text:     &slackText{Type: "plain_text", Text: truncate(btn[0], slackButtonMaxRunes)},
			URL:      btn[1],
			ActionID: btn[2],
		}
		if i == 0 {
			el.Style = "primary"
		}
		b.Elements = append(b.Elements, el)
	}
	return b
}

// slackEscape escapes the three characters Slack mrkdwn treats as control.
func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// slackLink is <url|label>.
func slackLink(url, label string) string {
	if url == "" || url == "#" {
		return slackEscape(label)
	}
	return "<" + url + "|" + slackEscape(strings.ReplaceAll(label, "|", "¦")) + ">"
}

// truncateMrkdwn caps mrkdwn text without splitting an escape sequence or a
// link.
func truncateMrkdwn(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	cut := []rune(s)[:max-1]
	str := string(cut)
	if i := strings.LastIndexAny(str, "&<"); i >= 0 && !strings.ContainsAny(str[i:], ";>") {
		str = str[:i]
	}
	return str + "…"
}

// noFence breaks up ``` so user text cannot close a code block.
func noFence(s string) string { return strings.ReplaceAll(s, "```", "`​``") }
