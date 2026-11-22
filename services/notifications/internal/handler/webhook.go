package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/sammaji/watchthatsite/services/core/config"
)

// Webhook request headers.
const (
	HeaderWebhookEvent     = "X-WatchThatSite-Event"
	HeaderWebhookSignature = "X-WatchThatSite-Signature"
	webhookTimeout         = 10 * time.Second
	webhookMaxBodyBytes    = 5 << 20
)

// WebhookHandler POSTs the rendered body to a user's endpoint, signed with
// the endpoint's secret.
type WebhookHandler struct {
	Client   *http.Client
	Insecure HostAllowlist
	Now      func() time.Time
}

func NewWebhookHandler(_ *config.Config) *WebhookHandler {
	insecure := LoadInsecureHosts()
	return &WebhookHandler{
		Client:   newUserURLClient(insecure, webhookTimeout),
		Insecure: insecure,
		Now:      time.Now,
	}
}

func (h *WebhookHandler) Channel() string { return string(ChannelWebhook) }

func (h *WebhookHandler) Validate(n *Notification) *HandlerError {
	n.Mu.Lock()
	defer n.Mu.Unlock()

	p := n.WebhookPayload
	if p == nil {
		return ErrorPermanentf(h.Channel(), "missing webhook payload")
	}
	u, err := url.Parse(p.URL)
	if err != nil || u.Host == "" {
		return ErrorPermanentf(h.Channel(), "invalid webhook url")
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && h.Insecure.AllowsHost(u.Hostname()):
	default:
		return ErrorPermanentf(h.Channel(), "webhook url must use https")
	}
	if u.User != nil {
		return ErrorPermanentf(h.Channel(), "webhook url must not carry credentials")
	}
	if p.Secret == "" {
		return ErrorPermanentf(h.Channel(), "missing webhook secret")
	}
	if p.Body == "" || !json.Valid([]byte(p.Body)) {
		return ErrorPermanentf(h.Channel(), "webhook body is not valid JSON")
	}
	if len(p.Body) > webhookMaxBodyBytes {
		return ErrorPermanentf(h.Channel(), "webhook body too large")
	}
	if p.Event == "" {
		p.Event = "change"
	}
	return nil
}

func (h *WebhookHandler) Send(ctx context.Context, n *Notification) *HandlerError {
	n.Mu.RLock()
	p := *n.WebhookPayload
	n.Mu.RUnlock()

	body := []byte(p.Body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL, bytes.NewReader(body))
	if err != nil {
		return ErrorPermanentf(h.Channel(), "build webhook request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "WatchThatSite-Webhook/1")
	req.Header.Set(HeaderWebhookEvent, p.Event)
	now := time.Now
	if h.Now != nil {
		now = h.Now
	}
	req.Header.Set(HeaderWebhookSignature, SignWebhook(p.Secret, body, now().Unix()))

	resp, err := h.Client.Do(req)
	if err != nil {
		if errors.Is(err, errBlockedAddress) {
			return ErrorPermanentf(h.Channel(), "%v", err)
		}
		return ErrorTransientf(h.Channel(), "%v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests, resp.StatusCode == http.StatusRequestTimeout, resp.StatusCode >= 500:
		return ErrorTransientf(h.Channel(), "webhook endpoint returned %d", resp.StatusCode)
	default:
		return ErrorPermanentf(h.Channel(), "webhook endpoint returned %d", resp.StatusCode)
	}
}

// SignWebhook returns the X-WatchThatSite-Signature value:
// "t={ts},v1={hex(HMAC-SHA256(secret, "{ts}.{body}"))}". It mirrors
// render.Sign in the scheduler.
func SignWebhook(secret string, body []byte, ts int64) string {
	t := strconv.FormatInt(ts, 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}
