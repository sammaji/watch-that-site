package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"os"
	"strings"
	"time"

	"github.com/resend/resend-go/v2"
	"github.com/sammaji/watchthatsite/services/core/config"
)

const emailMaxAttachmentSize = 1024 * 1024 * 10 // 10 MB

var emailAttachmentAllowedMimeTypes = map[string]struct{}{
	"application/pdf": {},
	"image/jpeg":      {},
	"image/png":       {},
	"image/gif":       {},
	"image/webp":      {},
	"text/plain":      {},
	"text/csv":        {},
}

// Email transports, chosen by EMAIL_TRANSPORT.
const (
	// EmailTransportResend (the default) sends through the Resend API.
	EmailTransportResend = "resend"
	// EmailTransportCapture POSTs {to, from, subject, html, text} as JSON to
	// EMAIL_CAPTURE_URL instead of sending, for local end-to-end tests.
	EmailTransportCapture = "capture"
)

type EmailHandler struct {
	Client     *resend.Client
	SenderAddr string
	SenderName string

	// Transport is EmailTransportResend or EmailTransportCapture.
	Transport  string
	CaptureURL string
	HTTP       *http.Client
}

func NewEmailHandler(cfg *config.Config) *EmailHandler {
	transport := strings.ToLower(strings.TrimSpace(os.Getenv("EMAIL_TRANSPORT")))
	if transport == "" {
		transport = EmailTransportResend
	}
	return &EmailHandler{
		Client:     resend.NewClient(cfg.Email.APIKey),
		SenderAddr: cfg.Email.FromAddr,
		SenderName: cfg.Email.FromName,
		Transport:  transport,
		CaptureURL: os.Getenv("EMAIL_CAPTURE_URL"),
		HTTP:       &http.Client{Timeout: 10 * time.Second},
	}
}

func (h *EmailHandler) Channel() string { return string(ChannelEmail) }

func (h *EmailHandler) Validate(n *Notification) *HandlerError {
	n.Mu.Lock()
	defer n.Mu.Unlock()

	if n.EmailPayload == nil {
		return ErrorPermanentf(h.Channel(), "missing email payload")
	}

	if n.EmailPayload.Subject == "" {
		return ErrorPermanentf(h.Channel(), "missing email subject")
	}

	if (n.EmailPayload.Text == nil || *n.EmailPayload.Text == "") && (n.EmailPayload.Html == nil || *n.EmailPayload.Html == "") {
		return ErrorPermanentf(h.Channel(), "missing email text or html")
	}

	if len(n.EmailPayload.Attachments) > 0 {
		for _, a := range n.EmailPayload.Attachments {
			if a.Filename == "" {
				return ErrorPermanentf(h.Channel(), "missing attachment filename")
			}
			if a.ContentType == "" {
				return ErrorPermanentf(h.Channel(), "missing attachment content-type")
			}
			if _, ok := emailAttachmentAllowedMimeTypes[a.ContentType]; !ok {
				return ErrorPermanentf(h.Channel(), "unsupported attachment content-type: %s", a.ContentType)
			}

			if len(a.Data) == 0 {
				return ErrorPermanentf(h.Channel(), "missing attachment data")
			} else if len(a.Data) > emailMaxAttachmentSize {
				return ErrorPermanentf(h.Channel(), "attachment too large")
			}

			resolvedMime := http.DetectContentType(a.Data)
			if resolvedMime != a.ContentType {
				return ErrorPermanentf(h.Channel(), "attachment mime mismatch with content-type")
			}
		}
	}

	receiver := strings.TrimSpace(n.EmailPayload.Reciever)
	if receiver == "" {
		return ErrorPermanentf(h.Channel(), "missing email")
	}
	if _, err := mail.ParseAddress(receiver); err != nil {
		return ErrorPermanentf(h.Channel(), "invalid email: %v", err)
	}

	n.EmailPayload.Reciever = receiver
	return nil
}

func (h *EmailHandler) Send(ctx context.Context, n *Notification) *HandlerError {
	n.Mu.RLock()
	payload := *n.EmailPayload
	n.Mu.RUnlock()

	from := h.SenderAddr
	if name := h.SenderName; name != "" {
		from = fmt.Sprintf("%s <%s>", name, h.SenderAddr)
	}

	if h.Transport == EmailTransportCapture {
		return h.capture(ctx, from, payload)
	}

	params := &resend.SendEmailRequest{
		From:    from,
		To:      []string{payload.Reciever},
		Subject: payload.Subject,
	}
	if payload.Html != nil && *payload.Html != "" {
		params.Html = *payload.Html
	}
	if payload.Text != nil && *payload.Text != "" {
		params.Text = *payload.Text
	}
	for _, a := range payload.Attachments {
		params.Attachments = append(params.Attachments, &resend.Attachment{
			Filename: a.Filename,
			Content:  a.Data,
		})
	}

	_, err := h.Client.Emails.SendWithContext(ctx, params)
	if err == nil {
		return nil
	}

	if errors.Is(err, resend.ErrRateLimit) {
		return ErrorTransientf(h.Channel(), "resend rate limited: %v", err)
	}

	return ErrorTransientf(h.Channel(), "%v", err)
}

// capture POSTs the rendered email to EMAIL_CAPTURE_URL (a local test sink)
// instead of sending it.
func (h *EmailHandler) capture(ctx context.Context, from string, payload EmailPayload) *HandlerError {
	if h.CaptureURL == "" {
		return ErrorPermanentf(h.Channel(), "EMAIL_TRANSPORT=capture requires EMAIL_CAPTURE_URL")
	}
	msg := map[string]string{
		"to":      payload.Reciever,
		"from":    from,
		"subject": payload.Subject,
		"html":    "",
		"text":    "",
	}
	if payload.Html != nil {
		msg["html"] = *payload.Html
	}
	if payload.Text != nil {
		msg["text"] = *payload.Text
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return ErrorPermanentf(h.Channel(), "encode captured email: %v", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.CaptureURL, bytes.NewReader(body))
	if err != nil {
		return ErrorPermanentf(h.Channel(), "build capture request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	client := h.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return ErrorTransientf(h.Channel(), "email capture: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return ErrorTransientf(h.Channel(), "email capture returned %d", resp.StatusCode)
	default:
		return ErrorPermanentf(h.Channel(), "email capture returned %d", resp.StatusCode)
	}
}
