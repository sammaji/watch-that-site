package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorder is a fake endpoint that records requests and answers with the
// next queued status (200 when the queue is empty).
type recorder struct {
	mu       sync.Mutex
	requests []recorded
	statuses []int
	reply    string
}

type recorded struct {
	path   string
	header http.Header
	body   []byte
}

func (r *recorder) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	r.requests = append(r.requests, recorded{path: req.URL.Path, header: req.Header.Clone(), body: body})
	status := http.StatusOK
	if len(r.statuses) > 0 {
		status, r.statuses = r.statuses[0], r.statuses[1:]
	}
	reply := r.reply
	r.mu.Unlock()
	if status == http.StatusFound {
		w.Header().Set("Location", "https://example.com/")
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, reply)
}

func newServer(t *testing.T, r *recorder) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func decode(t *testing.T, raw string) *Notification {
	t.Helper()
	var n Notification
	if err := json.Unmarshal([]byte(raw), &n); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	return &n
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func webhookEnvelope(t *testing.T, url, secret, body string) *Notification {
	return decode(t, mustJSON(t, map[string]any{
		"channel":    "notifications.webhook",
		"created_at": "2026-09-27T10:00:00Z",
		"payload":    map[string]string{"url": url, "secret": secret, "event": "change", "body": body},
	}))
}

func TestSignWebhookMatchesScheduler(t *testing.T) {
	// Same vector as services/scheduler/internal/render TestSign.
	got := SignWebhook("whsec_test", []byte(`{"id":"x"}`), 1700000000)
	want := "t=1700000000,v1=80e8d098018f757aa814ab1abb924f35d304affa1d93d29611a54696207eb7c3"
	if got != want {
		t.Fatalf("signature = %s, want %s", got, want)
	}
}

func TestWebhookSendsSignedBody(t *testing.T) {
	rec := &recorder{}
	srv := newServer(t, rec)
	h := &WebhookHandler{Insecure: ParseHostAllowlist("localhost, 127.0.0.1"), Now: func() time.Time { return time.Unix(1700000000, 0) }}
	h.Client = newUserURLClient(h.Insecure, time.Second)

	body := `{"id":"c1","monitor":{"name":"<A & B>"}}`
	n := webhookEnvelope(t, srv.URL+"/hook", "sek", body)
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := h.Send(context.Background(), n); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(rec.requests) != 1 {
		t.Fatalf("got %d requests", len(rec.requests))
	}
	r := rec.requests[0]
	if string(r.body) != body {
		t.Fatalf("body = %s, want %s", r.body, body)
	}
	if got := r.header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if got := r.header.Get(HeaderWebhookEvent); got != "change" {
		t.Fatalf("event = %q", got)
	}
	if got, want := r.header.Get(HeaderWebhookSignature), SignWebhook("sek", []byte(body), 1700000000); got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestWebhookStatusClassification(t *testing.T) {
	cases := map[int]bool{ // status -> permanent
		http.StatusInternalServerError: false,
		http.StatusBadGateway:          false,
		http.StatusTooManyRequests:     false,
		http.StatusBadRequest:          true,
		http.StatusNotFound:            true,
		http.StatusFound:               true,
	}
	for status, permanent := range cases {
		rec := &recorder{statuses: []int{status}}
		srv := newServer(t, rec)
		allow := ParseHostAllowlist("127.0.0.1")
		h := &WebhookHandler{Insecure: allow, Client: newUserURLClient(allow, time.Second), Now: time.Now}
		n := webhookEnvelope(t, srv.URL, "s", `{}`)
		if err := h.Validate(n); err != nil {
			t.Fatalf("validate: %v", err)
		}
		err := h.Send(context.Background(), n)
		if err == nil || err.IsPermanent != permanent {
			t.Fatalf("status %d: err = %v, want permanent=%v", status, err, permanent)
		}
	}
}

func TestWebhookNetworkErrorIsTransient(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	allow := ParseHostAllowlist("127.0.0.1")
	h := &WebhookHandler{Insecure: allow, Client: newUserURLClient(allow, time.Second), Now: time.Now}
	n := webhookEnvelope(t, url, "s", `{}`)
	if err := h.Send(context.Background(), n); err == nil || err.IsPermanent {
		t.Fatalf("err = %v, want transient", err)
	}
}

func TestWebhookBlocksPrivateAddresses(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewTLSServer(rec)
	defer srv.Close()
	h := &WebhookHandler{Client: newUserURLClient(nil, time.Second), Now: time.Now}
	n := webhookEnvelope(t, srv.URL, "s", `{}`)
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	err := h.Send(context.Background(), n)
	if err == nil || !err.IsPermanent || !strings.Contains(err.Error(), "not public") {
		t.Fatalf("err = %v, want permanent blocked address", err)
	}
	if len(rec.requests) != 0 {
		t.Fatal("request reached a private address")
	}
}

func TestWebhookValidate(t *testing.T) {
	h := &WebhookHandler{}
	for name, n := range map[string]*Notification{
		"http":        webhookEnvelope(t, "http://example.com/x", "s", `{}`),
		"no secret":   webhookEnvelope(t, "https://example.com/x", "", `{}`),
		"bad json":    webhookEnvelope(t, "https://example.com/x", "s", `{`),
		"no host":     webhookEnvelope(t, "https:///x", "s", `{}`),
		"credentials": webhookEnvelope(t, "https://u:p@example.com/x", "s", `{}`),
	} {
		if err := h.Validate(n); err == nil || !err.IsPermanent {
			t.Fatalf("%s: err = %v, want permanent", name, err)
		}
	}
	if err := h.Validate(webhookEnvelope(t, "https://example.com/x", "s", `{"a":1}`)); err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
}

func TestEmailCaptureTransport(t *testing.T) {
	rec := &recorder{}
	srv := newServer(t, rec)
	h := &EmailHandler{SenderAddr: "alerts@watchthat.test", SenderName: "WatchThatSite", Transport: EmailTransportCapture, CaptureURL: srv.URL + "/emails"}
	n := decode(t, mustJSON(t, map[string]any{
		"channel": "notifications.email",
		"payload": map[string]string{"subject": "Acme: Price 49 → 59", "reciever": " a@example.com ", "text": "plain", "html": "<p>$59</p>"},
	}))
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := h.Send(context.Background(), n); err != nil {
		t.Fatalf("send: %v", err)
	}
	var got map[string]string
	if err := json.Unmarshal(rec.requests[0].body, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"to": "a@example.com", "from": "WatchThatSite <alerts@watchthat.test>", "subject": "Acme: Price 49 → 59", "text": "plain", "html": "<p>$59</p>"}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestSlackInsecureHostOverride(t *testing.T) {
	rec := &recorder{reply: "ok"}
	srv := newServer(t, rec)
	env := mustJSON(t, map[string]any{
		"channel": "notifications.slack",
		"payload": map[string]any{
			"webhook_url": srv.URL + "/slack",
			"text":        "fallback",
			"blocks": []any{
				map[string]any{"type": "header", "text": map[string]any{"type": "plain_text", "text": "H", "emoji": true}},
				map[string]any{"type": "actions", "elements": []any{map[string]any{"type": "button", "text": map[string]any{"type": "plain_text", "text": "View change"}, "url": "https://app.test/changes/1", "action_id": "view_change", "style": "primary"}}},
			},
		},
	})

	if err := (&SlackHandler{}).Validate(decode(t, env)); err == nil {
		t.Fatal("non-Slack host accepted without the override")
	}
	h := &SlackHandler{client: http.DefaultClient, Insecure: ParseHostAllowlist("127.0.0.1")}
	n := decode(t, env)
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := h.Send(context.Background(), n); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !strings.Contains(string(rec.requests[0].body), `"url":"https://app.test/changes/1"`) {
		t.Fatalf("button url lost: %s", rec.requests[0].body)
	}
}

func TestDiscordEmbeds(t *testing.T) {
	rec := &recorder{statuses: []int{http.StatusNoContent}}
	srv := newServer(t, rec)
	embeds := `[{"title":"Price 49 → 59","url":"https://app.test/changes/1","description":"` + "```diff\\n- $49\\n+ $59\\n```" + `","image":{"url":"https://img.test/crop.png"}}]`
	n := decode(t, `{"channel":"notifications.discord","payload":{"type":"webhook","content":"Acme: Price 49 → 59","webhook_url":"`+srv.URL+`/discord","embeds":`+embeds+`}}`)
	if err := (&DiscordHandler{}).Validate(decode(t, `{"channel":"notifications.discord","payload":{"type":"webhook","content":"x","webhook_url":"`+srv.URL+`"}}`)); err == nil {
		t.Fatal("non-Discord host accepted without the override")
	}
	h := &DiscordHandler{Client: http.DefaultClient, Insecure: ParseHostAllowlist("127.0.0.1")}
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := h.Send(context.Background(), n); err != nil {
		t.Fatalf("send: %v", err)
	}
	var sent struct {
		Content string `json:"content"`
		Embeds  []struct {
			Image struct {
				URL string `json:"url"`
			} `json:"image"`
		} `json:"embeds"`
	}
	if err := json.Unmarshal(rec.requests[0].body, &sent); err != nil {
		t.Fatalf("body %s: %v", rec.requests[0].body, err)
	}
	if sent.Content != "Acme: Price 49 → 59" || len(sent.Embeds) != 1 || sent.Embeds[0].Image.URL != "https://img.test/crop.png" {
		t.Fatalf("unexpected body: %s", rec.requests[0].body)
	}

	// Embeds alone are enough.
	only := decode(t, `{"channel":"notifications.discord","payload":{"type":"webhook","content":"","webhook_url":"`+srv.URL+`","embeds":`+embeds+`}}`)
	if err := h.Validate(only); err != nil {
		t.Fatalf("embeds-only rejected: %v", err)
	}
}

func TestTelegramPhotoThenText(t *testing.T) {
	rec := &recorder{reply: `{"ok":true}`}
	srv := newServer(t, rec)
	h := &TelegramHandler{Client: http.DefaultClient, BotToken: "123:abc", APIBase: srv.URL}
	n := decode(t, mustJSON(t, map[string]any{
		"channel": "notifications.telegram",
		"payload": map[string]string{"chat_id": "42", "text": "<b>diff</b>", "parse_mode": "HTML", "photo_url": "https://img.test/crop.png", "caption": "<b>Acme</b>: Price 49 → 59"},
	}))
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := h.Send(context.Background(), n); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(rec.requests) != 2 || rec.requests[0].path != "/bot123:abc/sendPhoto" || rec.requests[1].path != "/bot123:abc/sendMessage" {
		t.Fatalf("unexpected calls: %+v", rec.requests)
	}
	var photo map[string]string
	_ = json.Unmarshal(rec.requests[0].body, &photo)
	if photo["photo"] != "https://img.test/crop.png" || photo["parse_mode"] != "HTML" || photo["caption"] == "" {
		t.Fatalf("photo body: %s", rec.requests[0].body)
	}
}

func TestTelegramPhotoRejectedFallsBackToCaption(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var lastText string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/sendPhoto") {
			_, _ = io.WriteString(w, `{"ok":false,"error_code":400,"description":"Bad Request: wrong file identifier/HTTP URL specified"}`)
			return
		}
		var m map[string]string
		_ = json.Unmarshal(body, &m)
		lastText = m["text"]
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()
	h := &TelegramHandler{Client: http.DefaultClient, BotToken: "t", APIBase: srv.URL}
	n := decode(t, `{"channel":"notifications.telegram","payload":{"chat_id":"1","photo_url":"https://img.test/x.png","caption":"cap","parse_mode":"HTML"}}`)
	if err := h.Validate(n); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := h.Send(context.Background(), n); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(paths) != 2 || lastText != "cap" {
		t.Fatalf("paths %v, text %q", paths, lastText)
	}
}

func TestHostAllowlist(t *testing.T) {
	a := ParseHostAllowlist(" localhost ,127.0.0.1,, ")
	for url, want := range map[string]bool{
		"http://localhost:4000/x":  true,
		"https://127.0.0.1/x":      true,
		"ftp://localhost/x":        false,
		"http://example.com/x":     false,
		"http://localhost.evil/x":  false,
		"https://hooks.slack.com/": false,
	} {
		if got := a.AllowsURL(url); got != want {
			t.Fatalf("AllowsURL(%s) = %v, want %v", url, got, want)
		}
	}
	if ParseHostAllowlist("").AllowsURL("http://localhost/") {
		t.Fatal("empty allowlist allows")
	}
}
