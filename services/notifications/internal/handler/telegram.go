package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bytedance/sonic"
	"github.com/sammaji/watchthatsite/services/core/config"
)

const (
	telegramAPIBase       = "https://api.telegram.org"
	telegramMaxText       = 4096
	telegramMaxCaption    = 1024
	telegramClientTimeout = 15 * time.Second
)

type TelegramHandler struct {
	Client   *http.Client
	BotToken string
	// APIBase is the Bot API origin; tests point it at a fake server.
	APIBase string
}

func NewTelegramHandler(cfg *config.Config) *TelegramHandler {
	return &TelegramHandler{Client: &http.Client{Timeout: telegramClientTimeout}, BotToken: cfg.Telegram.BotToken, APIBase: telegramAPIBase}
}

func (h *TelegramHandler) Channel() string { return string(ChannelTelegram) }

func (h *TelegramHandler) Validate(n *Notification) *HandlerError {
	n.Mu.Lock()
	defer n.Mu.Unlock()

	if n.TelegramPayload == nil {
		return ErrorPermanentf(h.Channel(), "missing telegram payload")
	}

	if n.TelegramPayload.Text == "" && n.TelegramPayload.PhotoURL == "" {
		return ErrorPermanentf(h.Channel(), "missing telegram text or photo")
	}
	if n.TelegramPayload.PhotoURL != "" && !strings.HasPrefix(n.TelegramPayload.PhotoURL, "https://") && !strings.HasPrefix(n.TelegramPayload.PhotoURL, "http://") {
		return ErrorPermanentf(h.Channel(), "telegram photo must be an http(s) url")
	}
	if utf8.RuneCountInString(n.TelegramPayload.Caption) > telegramMaxCaption {
		return ErrorPermanentf(h.Channel(), "telegram caption longer than %d characters", telegramMaxCaption)
	}
	if utf8.RuneCountInString(n.TelegramPayload.Text) > telegramMaxText {
		return ErrorPermanentf(h.Channel(), "telegram text longer than %d characters", telegramMaxText)
	}

	if n.TelegramPayload.ChatID == "" {
		return ErrorPermanentf(h.Channel(), "missing telegram chat id")
	}

	// do not check for empty string, since passing empty string should not be
	// a way to forcefully use the default bot token.
	if n.TelegramPayload.BotToken == nil {
		n.TelegramPayload.BotToken = &h.BotToken
	}
	if n.TelegramPayload.BotToken != nil && *n.TelegramPayload.BotToken == "" {
		return ErrorPermanentf(h.Channel(), "missing or invalid telegram bot token")
	}

	switch n.TelegramPayload.ParseMode {
	case "", TelegramParseModeHTML, TelegramParseModeMarkdownV2:
	default:
		return ErrorPermanentf(h.Channel(), "unsupported telegram parse mode %q", n.TelegramPayload.ParseMode)
	}

	return nil
}

// Send delivers the photo (with caption) when PhotoURL is set, then the text
// when there is any. If Telegram rejects the photo permanently (e.g. it
// cannot fetch the URL), the caption is sent as text instead so the
// notification is not lost.
func (h *TelegramHandler) Send(ctx context.Context, n *Notification) *HandlerError {
	n.Mu.RLock()
	payload := *n.TelegramPayload
	token := *n.TelegramPayload.BotToken
	n.Mu.RUnlock()

	base := h.APIBase
	if base == "" {
		base = telegramAPIBase
	}
	method := func(name string) string { return fmt.Sprintf("%s/bot%s/%s", base, token, name) }

	text := payload.Text
	if payload.PhotoURL != "" {
		photo := map[string]any{
			"chat_id": payload.ChatID,
			"photo":   payload.PhotoURL,
		}
		if payload.Caption != "" {
			photo["caption"] = payload.Caption
		}
		if payload.ParseMode != "" {
			photo["parse_mode"] = payload.ParseMode
		}
		body, err := sonic.Marshal(photo)
		if err != nil {
			return ErrorPermanentf(h.Channel(), "failed to create telegram photo payload: %v", err)
		}
		if herr := h.postMessage(ctx, method("sendPhoto"), body); herr != nil {
			if !herr.IsPermanent {
				return herr
			}
			// The photo was refused: fall back to text only.
			if text == "" {
				text = payload.Caption
			}
			if text == "" {
				return herr
			}
		}
	}
	if text == "" {
		return nil
	}

	data := map[string]any{
		"chat_id": payload.ChatID,
		"text":    text,
	}
	if payload.ParseMode != "" {
		data["parse_mode"] = payload.ParseMode
	}
	body, err := sonic.Marshal(data)
	if err != nil {
		return ErrorPermanentf(h.Channel(), "failed to create telegram payload: %v", err)
	}

	return h.postMessage(ctx, method("sendMessage"), body)
}

func (h *TelegramHandler) postMessage(ctx context.Context, apiURL string, body []byte) *HandlerError {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(body))
	if err != nil {
		return ErrorPermanentf(h.Channel(), "build telegram request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.Client.Do(req)
	if err != nil {
		return ErrorTransientf(h.Channel(), "%v", err)
	}
	defer resp.Body.Close()

	return h.handleTelegramErrors(resp)
}

func (h *TelegramHandler) handleTelegramErrors(resp *http.Response) *HandlerError {
	var tgResp struct {
		Ok          bool   `json:"ok"`
		Description string `json:"description"`
		ErrorCode   int    `json:"error_code"`
		Parameters  *struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tgResp); err != nil {
		return ErrorTransientf(h.Channel(), "decode telegram response: %v", err)
	}
	if tgResp.Ok {
		return nil
	}

	switch tgResp.ErrorCode {
	case 429:
		retryAfter := 0
		if tgResp.Parameters != nil {
			retryAfter = tgResp.Parameters.RetryAfter
		}
		return ErrorTransientf(h.Channel(), "telegram rate limited (retry after %ds)", retryAfter)
	case 400, 401, 403, 404:
		return ErrorPermanentf(h.Channel(), "telegram error %d: %s", tgResp.ErrorCode, tgResp.Description)
	default:
		if tgResp.ErrorCode >= 500 {
			return ErrorTransientf(h.Channel(), "telegram server error %d: %s", tgResp.ErrorCode, tgResp.Description)
		}
		return ErrorPermanentf(h.Channel(), "telegram error %d: %s", tgResp.ErrorCode, tgResp.Description)
	}
}
