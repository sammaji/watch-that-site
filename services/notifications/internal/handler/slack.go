package handler

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/bytedance/sonic"
	"github.com/sammaji/watchthatsite/services/core/config"
)

var slackWebhookURLPattern = regexp.MustCompile(`^https://hooks\.slack\.com/services/[A-Z0-9]{10,}/[A-Z0-9]{10,}/[A-Za-z0-9_-]{24,}$`)

type SlackHandler struct {
	client *http.Client
	// Insecure lists hosts (NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS) whose
	// http(s) URLs are accepted in place of hooks.slack.com, for local E2E.
	Insecure HostAllowlist
}

func NewSlackHandler(_ *config.Config) *SlackHandler {
	return &SlackHandler{client: &http.Client{Timeout: 15 * time.Second}, Insecure: LoadInsecureHosts()}
}

func (h *SlackHandler) Channel() string { return string(ChannelSlack) }

func (h *SlackHandler) Validate(n *Notification) *HandlerError {
	n.Mu.Lock()
	defer n.Mu.Unlock()

	if n.SlackPayload == nil {
		return ErrorPermanentf(h.Channel(), "missing slack payload")
	}

	webhookURL := n.SlackPayload.WebhookURL
	if webhookURL == "" || (!slackWebhookURLPattern.MatchString(webhookURL) && !h.Insecure.AllowsURL(webhookURL)) {
		return ErrorPermanentf(h.Channel(), "missing or invalid slack webhook url")
	}

	text := n.SlackPayload.Text
	blockCount := len(n.SlackPayload.Blocks)
	if (text == nil || *text == "") && blockCount == 0 {
		return ErrorPermanentf(h.Channel(), "missing slack text or blocks")
	}
	if blockCount > 50 {
		return ErrorPermanentf(h.Channel(), "too many slack blocks")
	}
	for i, block := range n.SlackPayload.Blocks {
		if err := h.validateSlackBlock(block, i); err != nil {
			return err
		}
	}

	return nil
}

func (h *SlackHandler) Send(ctx context.Context, n *Notification) *HandlerError {
	n.Mu.RLock()
	payload := *n.SlackPayload
	n.Mu.RUnlock()

	body, err := sonic.Marshal(struct {
		Text   *string      `json:"text,omitempty"`
		Blocks []SlackBlock `json:"blocks,omitempty"`
	}{
		Text:   payload.Text,
		Blocks: payload.Blocks,
	})
	if err != nil {
		return ErrorPermanentf(h.Channel(), "failed to create slack payload: %v", err)
	}

	return h.postWebhook(ctx, payload.WebhookURL, body)
}

func (h *SlackHandler) validateSlackBlock(block SlackBlock, index int) *HandlerError {
	if block.Type == "" {
		return ErrorPermanentf(h.Channel(), "missing slack block type at index %d", index)
	}
	if block.Text != nil {
		if err := h.validateSlackText(*block.Text, "block text", index); err != nil {
			return err
		}
	}
	for fieldIndex, field := range block.Fields {
		if err := h.validateSlackText(field, "block field", index, fieldIndex); err != nil {
			return err
		}
	}
	for elementIndex, element := range block.Elements {
		if err := h.validateSlackElement(element, "block element", index, elementIndex); err != nil {
			return err
		}
	}
	if block.Accessory != nil {
		if err := h.validateSlackElement(*block.Accessory, "block accessory", index); err != nil {
			return err
		}
	}
	return nil
}

func (h *SlackHandler) validateSlackText(text SlackText, label string, path ...int) *HandlerError {
	if text.Type == "" {
		return ErrorPermanentf(h.Channel(), "missing slack %s text type at %s", label, formatSlackPath(path...))
	}
	return nil
}

func (h *SlackHandler) validateSlackElement(element SlackElement, label string, path ...int) *HandlerError {
	if element.Type == "" {
		return ErrorPermanentf(h.Channel(), "missing slack %s type at %s", label, formatSlackPath(path...))
	}
	if element.Text != nil {
		if err := h.validateSlackText(*element.Text, label+" text", path...); err != nil {
			return err
		}
	}
	for i, child := range element.Elements {
		childPath := append(append([]int{}, path...), i)
		if err := h.validateSlackElement(child, label+" child", childPath...); err != nil {
			return err
		}
	}
	if element.Confirm != nil {
		if err := h.validateSlackText(element.Confirm.Title, label+" confirm title", path...); err != nil {
			return err
		}
		if err := h.validateSlackText(element.Confirm.Text, label+" confirm text", path...); err != nil {
			return err
		}
		if err := h.validateSlackText(element.Confirm.Confirm, label+" confirm button", path...); err != nil {
			return err
		}
		if err := h.validateSlackText(element.Confirm.Deny, label+" deny button", path...); err != nil {
			return err
		}
	}
	return nil
}

func formatSlackPath(path ...int) string {
	parts := make([]string, 0, len(path))
	for _, p := range path {
		parts = append(parts, strconv.Itoa(p))
	}
	return strings.Join(parts, ".")
}

func (h *SlackHandler) postWebhook(ctx context.Context, webhookURL string, body []byte) *HandlerError {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return ErrorPermanentf(h.Channel(), "%v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.client.Do(req)
	if err != nil {
		return ErrorTransientf(h.Channel(), "%v", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		raw, _ := io.ReadAll(resp.Body)
		if string(raw) != "ok" {
			return ErrorPermanentf(h.Channel(), "unexpected slack response: %s", raw)
		}
		return nil
	case http.StatusTooManyRequests:
		return ErrorTransientf(h.Channel(), "slack rate limited")
	case http.StatusNotFound, http.StatusGone:
		return ErrorPermanentf(h.Channel(), "slack webhook invalid or deleted (status %d)", resp.StatusCode)
	case http.StatusForbidden:
		return ErrorPermanentf(h.Channel(), "slack webhook forbidden")
	default:
		if resp.StatusCode >= 500 {
			return ErrorTransientf(h.Channel(), "slack server error (status %d)", resp.StatusCode)
		}
		raw, _ := io.ReadAll(resp.Body)
		return ErrorPermanentf(h.Channel(), "slack error %d: %s", resp.StatusCode, raw)
	}
}
