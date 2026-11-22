package notify

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/bytedance/sonic"
)

func buildEmailEnvelopes(raw json.RawMessage, payload NotificationPayload, now time.Time) ([]builtEnvelope, error) {
	var creds struct {
		Recipients []struct {
			Email string `json:"email"`
		} `json:"recipients"`
	}
	if err := sonic.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("decode email credentials: %w", err)
	}
	out := make([]builtEnvelope, 0, len(creds.Recipients))
	for _, r := range creds.Recipients {
		if r.Email == "" {
			continue
		}
		out = append(out, builtEnvelope{
			routingKey: RoutingKeyEmail,
			envelope: notificationEnvelope{
				Channel:   channelEmail,
				CreatedAt: now,
				Payload: map[string]any{
					"subject":  payload.Subject,
					"reciever": r.Email,
					"text":     payload.Text,
					"html":     payload.HTML,
				},
			},
		})
	}
	return out, nil
}

func buildSlackEnvelopes(raw json.RawMessage, payload NotificationPayload, now time.Time) ([]builtEnvelope, error) {
	var creds struct {
		Webhooks []struct {
			URL string `json:"url"`
		} `json:"webhooks"`
	}
	if err := sonic.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("decode slack credentials: %w", err)
	}
	out := make([]builtEnvelope, 0, len(creds.Webhooks))
	for _, w := range creds.Webhooks {
		if w.URL == "" {
			continue
		}
		slackPayload, err := slackBody(payload)
		if err != nil {
			return nil, err
		}
		slackPayload["webhook_url"] = w.URL

		out = append(out, builtEnvelope{
			routingKey: RoutingKeySlack,
			envelope: notificationEnvelope{
				Channel:   channelSlack,
				CreatedAt: now,
				Payload:   slackPayload,
			},
		})
	}
	return out, nil
}

// derefOr returns *v, or fallback when v is nil or empty.
func derefOr(v *string, fallback string) string {
	if v != nil && *v != "" {
		return *v
	}
	return fallback
}

// slackBody returns the Slack message fields (text, blocks). The pre-rendered
// Block Kit message wins; otherwise Text is sent, with an image block when
// ImageURL is set.
func slackBody(payload NotificationPayload) (map[string]any, error) {
	if len(payload.Slack) > 0 {
		var msg struct {
			Text   string          `json:"text"`
			Blocks json.RawMessage `json:"blocks"`
		}
		if err := json.Unmarshal(payload.Slack, &msg); err != nil {
			return nil, fmt.Errorf("decode rendered slack message: %w", err)
		}
		out := map[string]any{"text": msg.Text}
		if len(msg.Blocks) > 0 && string(msg.Blocks) != "null" {
			out["blocks"] = msg.Blocks
		}
		return out, nil
	}

	out := map[string]any{"text": payload.Text}
	// Slack renders Block Kit, so the diff is shown inline rather than as
	// a bare link. `text` stays as the notification/fallback summary.
	if payload.ImageURL != nil && *payload.ImageURL != "" {
		out["blocks"] = []map[string]any{
			{
				"type": "section",
				"text": map[string]any{"type": "mrkdwn", "text": derefOr(payload.Text, payload.Subject)},
			},
			{
				"type":      "image",
				"image_url": *payload.ImageURL,
				"alt_text":  payload.Subject,
			},
		}
	}
	return out, nil
}
