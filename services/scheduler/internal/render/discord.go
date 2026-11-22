package render

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
)

// Discord message limits.
const (
	DiscordMaxContentRunes     = 2000
	DiscordMaxTitleRunes       = 256
	DiscordMaxDescriptionRunes = 4096
	DiscordMaxEmbedTotalRunes  = 6000
	discordFooterMaxRunes      = 200
	discordColor               = 0x1f883d
)

type discordImage struct {
	URL string `json:"url"`
}

type discordFooter struct {
	Text string `json:"text"`
}

type discordEmbed struct {
	Title       string         `json:"title,omitempty"`
	URL         string         `json:"url,omitempty"`
	Description string         `json:"description,omitempty"`
	Color       int            `json:"color,omitempty"`
	Image       *discordImage  `json:"image,omitempty"`
	Footer      *discordFooter `json:"footer,omitempty"`
}

type discordMessage struct {
	Content string         `json:"content"`
	Embeds  []discordEmbed `json:"embeds"`
}

// Discord renders {content, embeds:[…]}: one embed titled with the summary,
// linking to the Change view, whose description holds the items as
// before → after (or, for a record without items, a ```diff block) and the
// action links, with the crop as its image. It keeps to Discord's limits
// (title 256, description 4096, embed total 6000).
func Discord(r changerecord.Record, links Links) (json.RawMessage, error) {
	title := truncate(Summary(r), DiscordMaxTitleRunes)
	footer := truncate(monitorName(r), discordFooterMaxRunes)

	var head strings.Builder
	if note := NoteLine(r); note != "" {
		head.WriteString(mdEscape(note) + "\n")
	}
	actions := "\n" + mdLink("View change", links.ViewURL(r)) + " · " +
		mdLink("This was Noise", links.NoiseURL(r)) + " · " +
		mdLink("Pause", links.PauseURL(r))

	budget := min(DiscordMaxDescriptionRunes, DiscordMaxEmbedTotalRunes-runes(title)-runes(footer)) -
		runes(head.String()) - runes(actions) - 64 /* fences and the more link text */ - runes(links.ViewURL(r))

	desc := head.String()
	if its := items(r); len(its.Lines) > 0 {
		shown := 0
		for _, l := range its.Lines {
			block := "**" + mdEscape(l.head()) + "**\n"
			switch {
			case l.Before != "" && l.After != "":
				block += "~~" + mdEscape(l.Before) + "~~ → " + mdEscape(l.After) + "\n"
			case l.After != "":
				block += mdEscape(l.After) + "\n"
			case l.Before != "":
				block += "~~" + mdEscape(l.Before) + "~~\n"
			}
			if runes(block) > budget {
				break
			}
			desc += block
			budget -= runes(block)
			shown++
		}
		if more := its.Total - shown; more > 0 {
			desc += mdLink(moreItemsText(more), links.ViewURL(r)) + "\n"
		}
	} else {
		cs := changes(r)
		shown := 0
		if len(cs.Lines) > 0 && budget > 0 {
			var text string
			text, shown = diffText(cs.Lines, budget)
			if shown > 0 {
				desc += "```diff\n" + noFence(text) + "\n```"
			}
		}
		if more := cs.Total - shown; more > 0 {
			desc += mdLink(moreText(more), links.ViewURL(r)) + "\n"
		}
	}
	desc += actions

	embed := discordEmbed{
		Title:       title,
		URL:         links.ViewURL(r),
		Description: truncate(desc, DiscordMaxDescriptionRunes),
		Color:       discordColor,
		Footer:      &discordFooter{Text: footer},
	}
	if img := links.Image(); img != "" {
		embed.Image = &discordImage{URL: img}
	}
	return json.Marshal(discordMessage{
		Content: truncate(Subject(r), DiscordMaxContentRunes),
		Embeds:  []discordEmbed{embed},
	})
}

// mdEscape escapes Discord markdown control characters in plain text.
func mdEscape(s string) string {
	return strings.NewReplacer(
		`\`, `\\`, "*", `\*`, "_", `\_`, "~", `\~`, "`", "\\`", "|", `\|`, ">", `\>`, "[", `\[`, "]", `\]`,
	).Replace(s)
}

// mdLink is [label](url).
func mdLink(label, url string) string {
	return "[" + mdEscape(label) + "](" + strings.ReplaceAll(url, ")", "%29") + ")"
}

func runes(s string) int { return utf8.RuneCountInString(s) }
