package notify

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/bytedance/sonic"
)

// buildWebhookEnvelopes emits one envelope per configured endpoint. The body
// travels as a JSON string so the notifications service POSTs (and signs)
// exactly the bytes the renderer produced.
//
// Credentials: {"endpoints":[{"url":"https://…","secret":"…"}]}.
func buildWebhookEnvelopes(raw json.RawMessage, payload NotificationPayload, now time.Time) ([]builtEnvelope, error) {
	var creds struct {
		Endpoints []struct {
			URL    string `json:"url"`
			Secret string `json:"secret"`
		} `json:"endpoints"`
	}
	if err := sonic.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("decode webhook credentials: %w", err)
	}

	body, event := payload.Webhook, payload.WebhookEvent
	if len(body) == 0 {
		// A payload built without the renderer still produces a useful body.
		legacy, err := json.Marshal(map[string]any{
			"event":   "notification",
			"subject": payload.Subject,
			"text":    derefOr(payload.Text, ""),
		})
		if err != nil {
			return nil, fmt.Errorf("encode webhook body: %w", err)
		}
		body, event = legacy, "notification"
	}
	if event == "" {
		event = "change"
	}

	out := make([]builtEnvelope, 0, len(creds.Endpoints))
	for _, e := range creds.Endpoints {
		if e.URL == "" {
			continue
		}
		out = append(out, builtEnvelope{
			routingKey: RoutingKeyWebhook,
			envelope: notificationEnvelope{
				Channel:   channelWebhook,
				CreatedAt: now,
				Payload: map[string]any{
					"url":    e.URL,
					"secret": e.Secret,
					"event":  event,
					"body":   string(body),
				},
			},
		})
	}
	return out, nil
}
