package render

import (
	"fmt"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
)

// Notification renders one Change Record for every Channel. Callers only
// call it for records with status `change`.
func Notification(r changerecord.Record, links Links) (notify.NotificationPayload, error) {
	slack, err := Slack(r, links)
	if err != nil {
		return notify.NotificationPayload{}, fmt.Errorf("render slack: %w", err)
	}
	discord, err := Discord(r, links)
	if err != nil {
		return notify.NotificationPayload{}, fmt.Errorf("render discord: %w", err)
	}
	webhook, err := Webhook(r)
	if err != nil {
		return notify.NotificationPayload{}, fmt.Errorf("render webhook: %w", err)
	}
	text := EmailText(r, links)
	htmlBody := EmailHTML(r, links)
	tg := Telegram(r, links)
	p := notify.NotificationPayload{
		Subject:      Subject(r),
		Text:         &text,
		HTML:         &htmlBody,
		Slack:        slack,
		Discord:      discord,
		Telegram:     &tg,
		Webhook:      webhook,
		WebhookEvent: EventChange,
	}
	if img := links.Image(); img != "" {
		p.ImageURL = &img
	}
	return p, nil
}
