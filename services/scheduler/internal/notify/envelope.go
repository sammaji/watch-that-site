package notify

import (
	"fmt"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
)

// channel routing keys mirror infra/rabbitmq/definitions.template.json bindings.
const (
	NotificationExchange = "notifications"
	RoutingKeyEmail      = "email"
	RoutingKeySlack      = "slack"
	RoutingKeyDiscord    = "discord"
	RoutingKeyTelegram   = "telegram"
	RoutingKeyWebhook    = "webhook"

	channelEmail    = "notifications.email"
	channelSlack    = "notifications.slack"
	channelDiscord  = "notifications.discord"
	channelTelegram = "notifications.telegram"
	channelWebhook  = "notifications.webhook"
)

// RoutingKeys returns every routing key the notifier publishes on, for wiring
// broker publishers.
func RoutingKeys() []string {
	return []string{RoutingKeyEmail, RoutingKeySlack, RoutingKeyDiscord, RoutingKeyTelegram, RoutingKeyWebhook}
}

// notificationEnvelope matches the shape consumed by services/notifications.
type notificationEnvelope struct {
	Channel   string    `json:"channel"`
	CreatedAt time.Time `json:"created_at"`
	Payload   any       `json:"payload"`
}

type builtEnvelope struct {
	routingKey string
	envelope   notificationEnvelope
}

// buildEnvelopesForConfig translates one notification_config row (channel +
// credentials JSON) into a list of per-target queue envelopes.
//
// Credentials shape per channel is defined in apps/web/lib/notifications.ts.
func buildEnvelopesForConfig(cfg db.NotificationConfig, payload NotificationPayload) ([]builtEnvelope, error) {
	now := time.Now().UTC()

	switch cfg.ChannelID {
	case "email":
		return buildEmailEnvelopes(cfg.Credentials, payload, now)
	case "slack":
		return buildSlackEnvelopes(cfg.Credentials, payload, now)
	case "discord":
		return buildDiscordEnvelopes(cfg.Credentials, payload, now)
	case "telegram":
		return buildTelegramEnvelopes(cfg.Credentials, payload, now)
	case "webhook":
		return buildWebhookEnvelopes(cfg.Credentials, payload, now)
	default:
		return nil, fmt.Errorf("unknown channel_id %q", cfg.ChannelID)
	}
}
