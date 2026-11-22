package render

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
)

// MonitorInfo identifies a Monitor for notifications that have no Change
// Record.
type MonitorInfo struct {
	ID   string
	Name string
	URL  string
}

func (m MonitorInfo) name() string {
	if s := oneLine(m.Name); s != "" {
		return s
	}
	if m.URL != "" {
		return m.URL
	}
	return "Monitor"
}

// alert is a notification about a Monitor rather than a Change.
type alert struct {
	event   string
	monitor MonitorInfo
	title   string // one line, after "{monitor}: "
	message string // one paragraph
	reason  string
	// failures is how many Runs in a row have failed.
	failures int
	at       time.Time
	links    Links
}

// FailureNotification tells the owner a Monitor keeps failing: failures Runs
// in a row could not be checked. reason is the machine reason of the latest
// one ("http_status", "challenge", "macro_failed", …) and detail its message.
// The caller sends it once per streak, when the streak reaches its threshold.
func FailureNotification(m MonitorInfo, reason, detail string, failures int, at time.Time, links Links) (notify.NotificationPayload, error) {
	msg := "The last " + plural(failures, "check", "checks") + " of this Monitor failed, so it is not being watched right now."
	if d := oneLine(detail); d != "" {
		msg += " Latest problem: " + d
	}
	msg += " Checks keep running, and you will not hear about this again until one succeeds and they start failing anew."
	return alert{
		event:    EventFailure,
		monitor:  m,
		title:    "this Monitor keeps failing",
		message:  msg,
		reason:   reason,
		failures: failures,
		at:       at,
		links:    links,
	}.payload()
}

func (a alert) subject() string {
	return truncate(oneLine(a.monitor.name()+": "+a.title), subjectMaxRunes)
}

func (a alert) monitorURL() string { return a.links.MonitorURL(a.monitor.ID) }

func (a alert) payload() (notify.NotificationPayload, error) {
	subject := a.subject()
	text := a.text()
	htmlBody := a.html()

	slack, err := json.Marshal(slackMessage{Text: subject, Blocks: []slackBlock{
		slackHeader(subject),
		slackSection("*" + slackLink(safeHref(a.monitor.URL), a.monitor.name()) + "*\n" + slackEscape(a.message)),
		slackActions([3]string{"Open Monitor", a.monitorURL(), "open_monitor"}),
	}})
	if err != nil {
		return notify.NotificationPayload{}, err
	}
	discord, err := json.Marshal(discordMessage{
		Content: truncate(subject, DiscordMaxContentRunes),
		Embeds: []discordEmbed{{
			Title:       truncate(subject, DiscordMaxTitleRunes),
			URL:         a.monitorURL(),
			Description: mdEscape(a.message) + "\n\n" + mdLink("Open Monitor", a.monitorURL()),
			Color:       0xcf222e,
			Footer:      &discordFooter{Text: truncate(a.monitor.name(), discordFooterMaxRunes)},
		}},
	})
	if err != nil {
		return notify.NotificationPayload{}, err
	}
	webhook, err := marshalNoEscape(map[string]any{
		"event":    a.event,
		"monitor":  map[string]string{"id": a.monitor.ID, "name": a.monitor.Name, "url": a.monitor.URL},
		"reason":   a.reason,
		"message":  a.message,
		"failures": a.failures,
		"at":       a.at.UTC(),
	})
	if err != nil {
		return notify.NotificationPayload{}, err
	}
	return notify.NotificationPayload{
		Subject:  subject,
		Text:     &text,
		HTML:     &htmlBody,
		Slack:    slack,
		Discord:  discord,
		Telegram: &notify.TelegramBody{Text: "<b>" + esc(subject) + "</b>\n" + esc(a.message) + "\n\n" + tgLink("Open Monitor", a.monitorURL())},
		Webhook:  webhook,

		WebhookEvent: a.event,
	}, nil
}

func (a alert) text() string {
	var b strings.Builder
	b.WriteString(a.subject() + "\n")
	if a.monitor.URL != "" {
		b.WriteString(a.monitor.URL + "\n")
	}
	b.WriteString("\n" + a.message + "\n\nOpen Monitor: " + a.monitorURL() + "\n")
	return b.String()
}

func (a alert) html() string {
	var b strings.Builder
	openEmail(&b, a.subject())
	b.WriteString(`<tr><td style="padding:20px 24px 4px;"><div style="font-size:12px;` + styleContext + `">` + esc(a.monitor.name()))
	if a.monitor.URL != "" {
		b.WriteString(` · <a href="` + attr(safeHref(a.monitor.URL)) + `" style="color:#656d76;">` + esc(truncate(a.monitor.URL, 80)) + `</a>`)
	}
	b.WriteString(`</div><div style="margin:6px 0 0;font-size:18px;font-weight:600;">` + esc(a.subject()) + `</div></td></tr>`)
	b.WriteString(`<tr><td style="padding:8px 24px;font-size:14px;line-height:1.5;">` + esc(a.message) + `</td></tr>`)
	writeEmailButtons(&b, [][2]string{{"Open Monitor", a.monitorURL()}})
	closeEmail(&b, `You get this because you watch `+esc(a.monitor.name())+` on WatchThatSite.`)
	return b.String()
}
