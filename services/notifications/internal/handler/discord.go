package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/bytedance/sonic"
	"github.com/sammaji/watchthatsite/services/core/config"
	"github.com/sammaji/watchthatsite/services/core/utils"
)

const (
	discordMaxContent = 2000
	discordMaxEmbeds  = 10
)

var discordWebhookURLPattern = regexp.MustCompile(`^https://discord\.com/api/webhooks/[0-9]{17,19}/[A-Za-z0-9_-]{60,}$`)

type DiscordHandler struct {
	Client   *http.Client
	BotToken string
	// Insecure lists hosts (NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS) whose
	// http(s) URLs are accepted in place of discord.com webhooks, for local
	// E2E.
	Insecure HostAllowlist
}

func NewDiscordHandler(cfg *config.Config) *DiscordHandler {
	return &DiscordHandler{Client: &http.Client{Timeout: 15 * time.Second}, BotToken: cfg.Discord.BotToken, Insecure: LoadInsecureHosts()}
}

func (h *DiscordHandler) Channel() string { return string(ChannelDiscord) }

func (h *DiscordHandler) Validate(n *Notification) *HandlerError {
	n.Mu.Lock()
	defer n.Mu.Unlock()

	if n.DiscordPayload == nil {
		return ErrorPermanentf(h.Channel(), "missing discord payload")
	}

	hasEmbeds := len(n.DiscordPayload.Embeds) > 0 && string(n.DiscordPayload.Embeds) != "null"
	if n.DiscordPayload.Content == "" && !hasEmbeds {
		return ErrorPermanentf(h.Channel(), "missing discord content or embeds")
	}
	if utf8.RuneCountInString(n.DiscordPayload.Content) > discordMaxContent {
		return ErrorPermanentf(h.Channel(), "discord content longer than %d characters", discordMaxContent)
	}
	if hasEmbeds {
		var embeds []json.RawMessage
		if err := json.Unmarshal(n.DiscordPayload.Embeds, &embeds); err != nil {
			return ErrorPermanentf(h.Channel(), "discord embeds must be a JSON array: %v", err)
		}
		if len(embeds) > discordMaxEmbeds {
			return ErrorPermanentf(h.Channel(), "too many discord embeds")
		}
	}

	switch n.DiscordPayload.Type {
	case DiscordDeliveryTypeWebhook:
		if !discordWebhookURLPattern.MatchString(n.DiscordPayload.WebhookURL) && !h.Insecure.AllowsURL(n.DiscordPayload.WebhookURL) {
			return ErrorPermanentf(h.Channel(), "invalid discord webhook url")
		}
	case DiscordDeliveryTypeBotChannel:
		if n.DiscordPayload.ChannelID == "" {
			return ErrorPermanentf(h.Channel(), "missing discord channel id")
		}
	case DiscordDeliveryTypeBotUser:
		if n.DiscordPayload.UserID == "" {
			return ErrorPermanentf(h.Channel(), "missing discord user id")
		}
	default:
		return ErrorPermanentf(h.Channel(), "unknown discord delivery type %q", n.DiscordPayload.Type)
	}

	if n.DiscordPayload.Type == DiscordDeliveryTypeBotChannel || n.DiscordPayload.Type == DiscordDeliveryTypeBotUser {
		// do not check for empty string, since passing empty string should not be
		// a way to forcefully use the default bot token.
		if n.DiscordPayload.BotToken == nil {
			n.DiscordPayload.BotToken = &h.BotToken
		}
		if n.DiscordPayload.BotToken != nil && *n.DiscordPayload.BotToken == "" {
			return ErrorPermanentf(h.Channel(), "missing or invalid discord bot token")
		}
	}

	return nil
}

func (h *DiscordHandler) Send(ctx context.Context, n *Notification) *HandlerError {
	n.Mu.RLock()
	payload := *n.DiscordPayload
	n.Mu.RUnlock()

	data := struct {
		Content   *string         `json:"content,omitempty"`
		Embeds    json.RawMessage `json:"embeds,omitempty"`
		Username  *string         `json:"username,omitempty"`
		AvatarURL *string         `json:"avatar_url,omitempty"`
	}{}
	if payload.Content != "" {
		data.Content = &payload.Content
	}
	if len(payload.Embeds) > 0 && string(payload.Embeds) != "null" {
		data.Embeds = payload.Embeds
	}
	if payload.Type == DiscordDeliveryTypeWebhook {
		data.Username = utils.Ptr("WatchThatSite")
		data.AvatarURL = utils.Ptr("https://wts.sammaji.com/favicon.ico")
	}
	body, err := sonic.Marshal(data)
	if err != nil {
		return ErrorPermanentf(h.Channel(), "failed to create discord payload: %v", err)
	}

	switch payload.Type {
	case DiscordDeliveryTypeWebhook:
		return h.postWebhook(ctx, payload.WebhookURL, body)
	case DiscordDeliveryTypeBotChannel:
		return h.postBotMessage(ctx, *n.DiscordPayload.BotToken, payload.ChannelID, body)
	case DiscordDeliveryTypeBotUser:
		dmID, err := h.openDMChannel(ctx, *n.DiscordPayload.BotToken, payload.UserID)
		if err != nil {
			return err
		}
		return h.postBotMessage(ctx, *n.DiscordPayload.BotToken, dmID, body)
	default:
		return ErrorPermanentf(h.Channel(), "unknown discord delivery type: %q", payload.Type)
	}
}

func (h *DiscordHandler) postWebhook(ctx context.Context, webhookURL string, body []byte) *HandlerError {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return ErrorPermanentf(h.Channel(), "build discord webhook request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.Client.Do(req)
	if err != nil {
		return ErrorTransientf(h.Channel(), "%v", err)
	}
	defer resp.Body.Close()

	return h.handleDiscordErrors(resp)
}

func (h *DiscordHandler) openDMChannel(ctx context.Context, botToken, userID string) (string, *HandlerError) {
	payload, _ := json.Marshal(map[string]string{"recipient_id": userID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://discord.com/api/v10/users/@me/channels", bytes.NewReader(payload))
	if err != nil {
		return "", ErrorPermanentf(h.Channel(), "build discord dm request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bot "+botToken)

	resp, err := h.Client.Do(req)
	if err != nil {
		return "", ErrorTransientf(h.Channel(), "open discord dm: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if err := h.handleDiscordErrors(resp); err != nil {
			return "", err
		}
	}

	var dm struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&dm); err != nil {
		return "", ErrorTransientf(h.Channel(), "decode discord dm channel: %v", err)
	}
	if dm.ID == "" {
		return "", ErrorPermanentf(h.Channel(), "discord dm response missing channel id")
	}
	return dm.ID, nil
}

func (h *DiscordHandler) postBotMessage(ctx context.Context, botToken, channelID string, body []byte) *HandlerError {
	url := fmt.Sprintf("https://discord.com/api/v10/channels/%s/messages", channelID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return ErrorPermanentf(h.Channel(), "build discord bot request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bot "+botToken)

	resp, err := h.Client.Do(req)
	if err != nil {
		return ErrorTransientf(h.Channel(), "%v", err)
	}
	defer resp.Body.Close()

	return h.handleDiscordErrors(resp)
}

func (h *DiscordHandler) handleDiscordErrors(resp *http.Response) *HandlerError {
	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusNoContent:
		return nil
	case http.StatusTooManyRequests:
		var rl struct {
			RetryAfter float64 `json:"retry_after"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&rl)
		return ErrorTransientf(h.Channel(), "discord rate limited (retry after %.1fs)", rl.RetryAfter)
	case http.StatusNotFound:
		return ErrorPermanentf(h.Channel(), "discord target not found")
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden:
		var errBody struct {
			Message string `json:"message"`
			Code    int    `json:"code"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		return ErrorPermanentf(h.Channel(), "discord error %d (status %s)", resp.StatusCode, errBody.Message)
	default:
		if resp.StatusCode >= 500 {
			return ErrorTransientf(h.Channel(), "discord server error (status %d)", resp.StatusCode)
		}
		return ErrorPermanentf(h.Channel(), "discord unexpected status (status %d)", resp.StatusCode)
	}
}
