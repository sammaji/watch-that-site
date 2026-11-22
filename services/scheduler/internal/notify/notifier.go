// Package notify fans a single notification payload out to every configured
// channel target (email/Slack/Discord/Telegram/webhook) as individual queue messages.
package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/broker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
)

const maxConcurrentPublish = 10

// NotificationPayload is the user-facing message bundle forwarded to every
// target. The render package fills every field from one Change Record; each
// channel's envelope builder picks the body it needs:
//
//   - email:    Subject + HTML + Text (both parts are sent)
//   - slack:    Slack (Block Kit {text, blocks}); falls back to Text
//   - discord:  Discord ({content, embeds}); falls back to Text
//   - telegram: Telegram (HTML text, photo + caption); falls back to Text
//   - webhook:  Webhook (raw JSON body, signed by the notifications service)
//
// The legacy fields (Subject, Text, HTML, ImageURL) alone still produce a
// valid message on every channel.
type NotificationPayload struct {
	Subject string  `json:"subject"`
	Text    *string `json:"text,omitempty"`
	HTML    *string `json:"html,omitempty"`
	// ImageURL illustrates the change. Channels that can render an image use
	// it; the rest already carry the same link inside Text.
	ImageURL *string `json:"image_url,omitempty"`

	// Slack is a pre-rendered Block Kit message: {"text": …, "blocks": […]}.
	Slack json.RawMessage `json:"slack,omitempty"`
	// Discord is a pre-rendered message: {"content": …, "embeds": […]}.
	Discord json.RawMessage `json:"discord,omitempty"`
	// Telegram is a pre-rendered HTML-parse-mode message.
	Telegram *TelegramBody `json:"telegram,omitempty"`
	// Webhook is the exact JSON body POSTed to webhook endpoints (the Change
	// Record for a change).
	Webhook []byte `json:"webhook,omitempty"`
	// WebhookEvent names the webhook body: "change", "digest" or "failure".
	// Sent as the X-WatchThatSite-Event header.
	WebhookEvent string `json:"webhook_event,omitempty"`
}

// TelegramBody is a Telegram message in HTML parse mode. When PhotoURL is set
// the photo is sent with Caption; Text (if any) follows as a second message.
type TelegramBody struct {
	Text     string `json:"text,omitempty"`
	PhotoURL string `json:"photo_url,omitempty"`
	Caption  string `json:"caption,omitempty"`
}

// ConfigSource supplies a user's notification configs. Satisfied by
// cache.NotificationConfigCache.
type ConfigSource interface {
	Get(ctx context.Context, userID string) ([]db.NotificationConfig, error)
}

// Notifier resolves a user's notification configs and publishes one message per
// target.
type Notifier struct {
	configs   ConfigSource
	publisher broker.Publisher
	logger    *slog.Logger
}

func NewNotifier(configs ConfigSource, publisher broker.Publisher, logger *slog.Logger) *Notifier {
	return &Notifier{configs: configs, publisher: publisher, logger: logger}
}

// Send fans out a single payload to every target the user has configured.
//
// Each target becomes one message on the channel's queue. Publishes are
// concurrent; the first error per target is collected, but a partial failure
// does not stop the remaining sends.
func (n *Notifier) Send(ctx context.Context, userID string, payload NotificationPayload) error {
	configs, err := n.configs.Get(ctx, userID)
	if err != nil {
		return fmt.Errorf("load notification configs: %w", err)
	}
	if len(configs) == 0 {
		n.logger.Info("no notification configs for user", "user_id", userID)
		return nil
	}

	var jobs []builtEnvelope
	for _, cfg := range configs {
		built, err := buildEnvelopesForConfig(cfg, payload)
		if err != nil {
			n.logger.Warn("skipping notification_config with invalid credentials",
				"config_id", cfg.ID, "channel", cfg.ChannelID, "err", err)
			continue
		}
		jobs = append(jobs, built...)
	}

	if len(jobs) == 0 {
		n.logger.Info("no notification targets resolved", "user_id", userID)
		return nil
	}

	n.logger.Info("publishing notifications", "user_id", userID, "targets", len(jobs))

	sem := make(chan struct{}, maxConcurrentPublish)
	var wg sync.WaitGroup
	errs := make([]error, len(jobs))

loop:
	for i, j := range jobs {
		select {
		case <-ctx.Done():
			n.logger.Warn("notification context expired, aborting remaining publishes")
			break loop
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(i int, j builtEnvelope) {
			defer func() { <-sem; wg.Done() }()
			errs[i] = n.publisher.Publish(ctx, j.routingKey, j.envelope)
		}(i, j)
	}
	wg.Wait()

	var failed int
	for _, e := range errs {
		if e != nil {
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d/%d notification publishes failed", failed, len(jobs))
	}
	return nil
}
