package render

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
)

// DigestEntry is one Change in a digest. It is deliberately slim so the
// digest job can build it from digest_items/changes rows without loading
// full Change Records.
type DigestEntry struct {
	ChangeID    string    `json:"id"`
	MonitorID   string    `json:"monitor_id"`
	MonitorName string    `json:"monitor_name"`
	Summary     string    `json:"summary"`
	At          time.Time `json:"at"`
}

type digestGroup struct {
	MonitorID   string
	MonitorName string
	Entries     []DigestEntry
}

// groupDigest groups entries by Monitor (Monitors by name, then id; changes
// by time, then id), so output is deterministic.
func groupDigest(entries []DigestEntry) []digestGroup {
	byID := map[string]*digestGroup{}
	var order []*digestGroup
	for _, e := range entries {
		g, ok := byID[e.MonitorID]
		if !ok {
			name := oneLine(e.MonitorName)
			if name == "" {
				name = "Monitor"
			}
			g = &digestGroup{MonitorID: e.MonitorID, MonitorName: name}
			byID[e.MonitorID] = g
			order = append(order, g)
		}
		g.Entries = append(g.Entries, e)
	}
	sort.SliceStable(order, func(i, j int) bool {
		if order[i].MonitorName != order[j].MonitorName {
			return order[i].MonitorName < order[j].MonitorName
		}
		return order[i].MonitorID < order[j].MonitorID
	})
	out := make([]digestGroup, len(order))
	for i, g := range order {
		sort.SliceStable(g.Entries, func(a, b int) bool {
			if !g.Entries[a].At.Equal(g.Entries[b].At) {
				return g.Entries[a].At.Before(g.Entries[b].At)
			}
			return g.Entries[a].ChangeID < g.Entries[b].ChangeID
		})
		out[i] = *g
	}
	return out
}

func bucketLabel(bucket string) string {
	switch bucket {
	case "hourly":
		return "Hourly"
	case "daily":
		return "Daily"
	case "":
		return "Your"
	}
	return strings.ToUpper(bucket[:1]) + bucket[1:]
}

func entrySummary(e DigestEntry) string {
	if s := oneLine(e.Summary); s != "" {
		return truncate(s, 200)
	}
	return "Changed"
}

func entryTime(e DigestEntry) string { return e.At.UTC().Format("Jan 2, 15:04 UTC") }

// DigestSubject is e.g. "Hourly digest: 7 changes on 3 monitors".
func DigestSubject(entries []DigestEntry, bucket string) string {
	groups := groupDigest(entries)
	return fmt.Sprintf("%s digest: %s on %s", bucketLabel(bucket),
		plural(len(entries), "change", "changes"), plural(len(groups), "monitor", "monitors"))
}

// DigestEmailHTML renders the digest email: one section per Monitor, each
// change as its summary linking to /changes/{id}.
func DigestEmailHTML(entries []DigestEntry, bucket string, links Links) string {
	var b strings.Builder
	subject := DigestSubject(entries, bucket)
	openEmail(&b, subject)
	b.WriteString(`<tr><td style="padding:20px 24px 8px;font-size:18px;font-weight:600;">` + esc(subject) + `</td></tr>`)
	for _, g := range groupDigest(entries) {
		b.WriteString(`<tr><td style="padding:8px 24px;">`)
		b.WriteString(`<div style="font-size:15px;font-weight:600;margin:0 0 6px;"><a href="` + attr(links.MonitorURL(g.MonitorID)) + `" style="color:#1f2328;text-decoration:none;">` + esc(g.MonitorName) + `</a></div>`)
		b.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #d0d7de;border-radius:6px;font-size:14px;line-height:1.5;">`)
		for i, e := range g.Entries {
			border := ""
			if i > 0 {
				border = "border-top:1px solid #d0d7de;"
			}
			b.WriteString(`<tr><td style="padding:8px 10px;` + border + `"><a href="` + attr(links.ChangeURL(e.ChangeID)) + `" style="color:#0969da;text-decoration:none;">` + esc(entrySummary(e)) + `</a></td>`)
			b.WriteString(`<td align="right" style="padding:8px 10px;white-space:nowrap;font-size:12px;` + border + styleContext + `">` + esc(entryTime(e)) + `</td></tr>`)
		}
		b.WriteString(`</table></td></tr>`)
	}
	closeEmail(&b, `You get this digest because some of your Monitors are set to `+esc(strings.ToLower(bucketLabel(bucket)))+` notifications on WatchThatSite.`)
	return b.String()
}

// DigestText renders the plain-text digest.
func DigestText(entries []DigestEntry, bucket string, links Links) string {
	var b strings.Builder
	b.WriteString(DigestSubject(entries, bucket) + "\n")
	for _, g := range groupDigest(entries) {
		b.WriteString("\n" + g.MonitorName + "\n")
		for _, e := range g.Entries {
			b.WriteString("- " + entrySummary(e) + " (" + entryTime(e) + ")\n  " + links.ChangeURL(e.ChangeID) + "\n")
		}
	}
	return b.String()
}

// DigestSlack renders the digest as Block Kit: a header and one section per
// Monitor (at most 48, then a "more" section), each within 3,000 characters.
func DigestSlack(entries []DigestEntry, bucket string, links Links) (json.RawMessage, error) {
	subject := DigestSubject(entries, bucket)
	msg := slackMessage{Text: subject, Blocks: []slackBlock{slackHeader(subject)}}
	groups := groupDigest(entries)
	maxGroups := SlackMaxBlocks - 2
	for i, g := range groups {
		if i == maxGroups {
			rest := 0
			for _, g := range groups[i:] {
				rest += len(g.Entries)
			}
			msg.Blocks = append(msg.Blocks, slackSection(slackEscape(fmt.Sprintf("…and %s on %s more.",
				plural(rest, "change", "changes"), plural(len(groups)-i, "monitor", "monitors")))))
			break
		}
		head := "*" + slackLink(links.MonitorURL(g.MonitorID), g.MonitorName) + "*"
		lines := make([]string, 0, len(g.Entries))
		for _, e := range g.Entries {
			lines = append(lines, "• "+slackLink(links.ChangeURL(e.ChangeID), entrySummary(e))+" · "+entryTime(e))
		}
		msg.Blocks = append(msg.Blocks, slackSection(fitLines(head, lines, SlackMaxTextRunes, func(n int) string {
			return slackLink(links.MonitorURL(g.MonitorID), fmt.Sprintf("…and %d more", n))
		})))
	}
	return json.Marshal(msg)
}

// DigestDiscord renders the digest as one embed listing each Monitor's
// changes as links, within Discord's limits.
func DigestDiscord(entries []DigestEntry, bucket string, links Links) (json.RawMessage, error) {
	subject := DigestSubject(entries, bucket)
	var lines []string
	for _, g := range groupDigest(entries) {
		lines = append(lines, "**"+mdEscape(g.MonitorName)+"**")
		for _, e := range g.Entries {
			lines = append(lines, "• "+mdLink(entrySummary(e), links.ChangeURL(e.ChangeID))+" · "+entryTime(e))
		}
	}
	budget := min(DiscordMaxDescriptionRunes, DiscordMaxEmbedTotalRunes-runes(subject)) - 10
	desc := fitLines("", lines, budget, func(n int) string { return fmt.Sprintf("…and %d more lines", n) })
	return json.Marshal(discordMessage{
		Content: truncate(subject, DiscordMaxContentRunes),
		Embeds:  []discordEmbed{{Title: truncate(subject, DiscordMaxTitleRunes), Description: desc, Color: discordColor}},
	})
}

// DigestTelegram renders the digest in Telegram HTML.
func DigestTelegram(entries []DigestEntry, bucket string, links Links) notify.TelegramBody {
	var lines []string
	for _, g := range groupDigest(entries) {
		lines = append(lines, "", "<b>"+esc(g.MonitorName)+"</b>")
		for _, e := range g.Entries {
			lines = append(lines, "• "+tgLink(entrySummary(e), links.ChangeURL(e.ChangeID))+" · "+esc(entryTime(e)))
		}
	}
	head := "<b>" + esc(DigestSubject(entries, bucket)) + "</b>"
	return notify.TelegramBody{Text: fitLines(head, lines, TelegramMaxTextRunes, func(n int) string {
		return fmt.Sprintf("…and %d more lines", n)
	})}
}

// DigestWebhook is the digest webhook body.
func DigestWebhook(entries []DigestEntry, bucket string, links Links) ([]byte, error) {
	type change struct {
		DigestEntry
		URL string `json:"url"`
	}
	out := struct {
		Event   string   `json:"event"`
		Bucket  string   `json:"bucket"`
		Changes []change `json:"changes"`
	}{Event: EventDigest, Bucket: bucket, Changes: []change{}}
	for _, g := range groupDigest(entries) {
		for _, e := range g.Entries {
			out.Changes = append(out.Changes, change{DigestEntry: e, URL: links.ChangeURL(e.ChangeID)})
		}
	}
	return marshalNoEscape(out)
}

// DigestNotification bundles every channel's digest body.
func DigestNotification(entries []DigestEntry, bucket string, links Links) (notify.NotificationPayload, error) {
	slack, err := DigestSlack(entries, bucket, links)
	if err != nil {
		return notify.NotificationPayload{}, err
	}
	discord, err := DigestDiscord(entries, bucket, links)
	if err != nil {
		return notify.NotificationPayload{}, err
	}
	webhook, err := DigestWebhook(entries, bucket, links)
	if err != nil {
		return notify.NotificationPayload{}, err
	}
	text := DigestText(entries, bucket, links)
	htmlBody := DigestEmailHTML(entries, bucket, links)
	tg := DigestTelegram(entries, bucket, links)
	return notify.NotificationPayload{
		Subject:      DigestSubject(entries, bucket),
		Text:         &text,
		HTML:         &htmlBody,
		Slack:        slack,
		Discord:      discord,
		Telegram:     &tg,
		Webhook:      webhook,
		WebhookEvent: EventDigest,
	}, nil
}

// fitLines joins head and lines with newlines within max runes, replacing
// the lines that do not fit with more(n).
func fitLines(head string, lines []string, max int, more func(n int) string) string {
	var b strings.Builder
	b.WriteString(head)
	used := runes(head)
	for i, l := range lines {
		add := l
		if used > 0 {
			add = "\n" + l
		}
		tail := "\n" + more(len(lines)-i)
		if used+runes(add)+runes(tail) > max && i < len(lines) {
			// Only cut when the rest cannot all fit.
			restSize := 0
			for _, r := range lines[i:] {
				restSize += runes(r) + 1
			}
			if used+restSize > max {
				b.WriteString(tail)
				return strings.TrimPrefix(b.String(), "\n")
			}
		}
		b.WriteString(add)
		used += runes(add)
	}
	return b.String()
}
