package notify

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/bytedance/sonic"
)

func buildTelegramEnvelopes(raw json.RawMessage, payload NotificationPayload, now time.Time) ([]builtEnvelope, error) {
	var creds struct {
		BotToken *string `json:"bot_token"`
		Chats    []struct {
			ChatID string `json:"chat_id"`
		} `json:"chats"`
	}
	if err := sonic.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("decode telegram credentials: %w", err)
	}

	body := telegramBody(payload)
	out := make([]builtEnvelope, 0, len(creds.Chats))
	for _, c := range creds.Chats {
		if c.ChatID == "" {
			continue
		}
		p := map[string]any{
			"chat_id": c.ChatID,
			"text":    body.Text,
		}
		if body.parseMode != "" {
			p["parse_mode"] = body.parseMode
		}
		if body.PhotoURL != "" {
			p["photo_url"] = body.PhotoURL
			p["caption"] = body.Caption
		}
		if creds.BotToken != nil {
			p["bot_token"] = *creds.BotToken
		}
		out = append(out, builtEnvelope{
			routingKey: RoutingKeyTelegram,
			envelope:   notificationEnvelope{Channel: channelTelegram, CreatedAt: now, Payload: p},
		})
	}
	return out, nil
}

type telegramMessage struct {
	TelegramBody
	parseMode string
}

// telegramBody returns the pre-rendered HTML message, or Text sent as plain
// text (legacy payloads are not HTML-escaped).
func telegramBody(payload NotificationPayload) telegramMessage {
	if payload.Telegram != nil {
		return telegramMessage{TelegramBody: *payload.Telegram, parseMode: "HTML"}
	}
	return telegramMessage{TelegramBody: TelegramBody{Text: derefOr(payload.Text, "")}}
}
