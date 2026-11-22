package notify

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/bytedance/sonic"
)

// buildDiscordEnvelopes handles webhook, bot_token, and watchthatsite_bot
// variants — discriminated by whether webhooks vs bot_token vs neither is set.
func buildDiscordEnvelopes(raw json.RawMessage, payload NotificationPayload, now time.Time) ([]builtEnvelope, error) {
	var creds struct {
		Webhooks []struct {
			URL string `json:"url"`
		} `json:"webhooks"`
		BotToken *string `json:"bot_token"`
		Channels []struct {
			ChannelID string `json:"channel_id"`
		} `json:"channels"`
		Users []struct {
			UserID string `json:"user_id"`
		} `json:"users"`
	}
	if err := sonic.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("decode discord credentials: %w", err)
	}

	content, embeds, err := discordBody(payload)
	if err != nil {
		return nil, err
	}
	// withBody adds the rendered message fields to a per-target payload.
	withBody := func(p map[string]any) map[string]any {
		p["content"] = content
		if len(embeds) > 0 {
			p["embeds"] = embeds
		}
		return p
	}

	var out []builtEnvelope
	for _, w := range creds.Webhooks {
		if w.URL == "" {
			continue
		}
		out = append(out, builtEnvelope{
			routingKey: RoutingKeyDiscord,
			envelope: notificationEnvelope{
				Channel:   channelDiscord,
				CreatedAt: now,
				Payload: withBody(map[string]any{
					"type":        "webhook",
					"webhook_url": w.URL,
				}),
			},
		})
	}
	for _, ch := range creds.Channels {
		if ch.ChannelID == "" {
			continue
		}
		p := withBody(map[string]any{
			"type":       "bot_channel",
			"channel_id": ch.ChannelID,
		})
		if creds.BotToken != nil {
			p["bot_token"] = *creds.BotToken
		}
		out = append(out, builtEnvelope{
			routingKey: RoutingKeyDiscord,
			envelope:   notificationEnvelope{Channel: channelDiscord, CreatedAt: now, Payload: p},
		})
	}
	for _, u := range creds.Users {
		if u.UserID == "" {
			continue
		}
		p := withBody(map[string]any{
			"type":    "bot_user",
			"user_id": u.UserID,
		})
		if creds.BotToken != nil {
			p["bot_token"] = *creds.BotToken
		}
		out = append(out, builtEnvelope{
			routingKey: RoutingKeyDiscord,
			envelope:   notificationEnvelope{Channel: channelDiscord, CreatedAt: now, Payload: p},
		})
	}
	return out, nil
}

// discordBody returns the message content and embeds. The pre-rendered
// message wins; otherwise Text is the content, with an image embed when
// ImageURL is set.
func discordBody(payload NotificationPayload) (string, json.RawMessage, error) {
	if len(payload.Discord) > 0 {
		var msg struct {
			Content string          `json:"content"`
			Embeds  json.RawMessage `json:"embeds"`
		}
		if err := json.Unmarshal(payload.Discord, &msg); err != nil {
			return "", nil, fmt.Errorf("decode rendered discord message: %w", err)
		}
		if string(msg.Embeds) == "null" {
			msg.Embeds = nil
		}
		return msg.Content, msg.Embeds, nil
	}
	content := derefOr(payload.Text, "")
	if payload.ImageURL != nil && *payload.ImageURL != "" {
		embeds, err := json.Marshal([]map[string]any{{"image": map[string]string{"url": *payload.ImageURL}}})
		if err != nil {
			return "", nil, err
		}
		return content, embeds, nil
	}
	return content, nil, nil
}
