package notify

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/sammaji/watchthatsite/services/core/utils"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/stretchr/testify/require"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeConfigSource stubs the notification config lookup.
type fakeConfigSource struct {
	configs []db.NotificationConfig
	err     error
}

func (f fakeConfigSource) Get(context.Context, string) ([]db.NotificationConfig, error) {
	return f.configs, f.err
}

// fakePublisher records publishes and can fail by routing key.
type fakePublisher struct {
	mu       sync.Mutex
	calls    map[string]int
	failKeys map[string]bool
}

func newFakePublisher(failKeys ...string) *fakePublisher {
	fk := make(map[string]bool, len(failKeys))
	for _, k := range failKeys {
		fk[k] = true
	}
	return &fakePublisher{calls: map[string]int{}, failKeys: fk}
}

func (p *fakePublisher) Publish(_ context.Context, routingKey string, _ any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls[routingKey]++
	if p.failKeys[routingKey] {
		return errors.New("publish failed")
	}
	return nil
}

func (p *fakePublisher) count(routingKey string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[routingKey]
}

func TestBuildEnvelopesForConfig_Email(t *testing.T) {
	start := time.Now().UTC()
	payload := NotificationPayload{Subject: "subject", Text: utils.Ptr("hello"), HTML: utils.Ptr("<b>hello</b>")}
	cfg := db.NotificationConfig{
		ChannelID:   "email",
		Credentials: json.RawMessage(`{"recipients":[{"email":"a@example.com"},{"email":""},{"email":"b@example.com"}]}`),
	}

	envelopes, err := buildEnvelopesForConfig(cfg, payload)
	require.NoError(t, err)
	require.Len(t, envelopes, 2)

	first := envelopes[0]
	require.Equal(t, RoutingKeyEmail, first.routingKey)
	require.Equal(t, channelEmail, first.envelope.Channel)
	require.WithinDuration(t, start, first.envelope.CreatedAt, time.Second)
	firstPayload := first.envelope.Payload.(map[string]any)
	require.Equal(t, "subject", firstPayload["subject"])
	require.Equal(t, "a@example.com", firstPayload["reciever"])
	require.Equal(t, payload.Text, firstPayload["text"])
	require.Equal(t, payload.HTML, firstPayload["html"])

	require.Equal(t, "b@example.com", envelopes[1].envelope.Payload.(map[string]any)["reciever"])
}

func TestBuildEnvelopesForConfig_Slack(t *testing.T) {
	payload := NotificationPayload{Text: utils.Ptr("hello")}
	cfg := db.NotificationConfig{
		ChannelID:   "slack",
		Credentials: json.RawMessage(`{"webhooks":[{"url":"https://hooks.slack.com/services/A/B/C"},{"url":""}]}`),
	}

	envelopes, err := buildEnvelopesForConfig(cfg, payload)
	require.NoError(t, err)
	require.Len(t, envelopes, 1)
	require.Equal(t, RoutingKeySlack, envelopes[0].routingKey)
	got := envelopes[0].envelope.Payload.(map[string]any)
	require.Equal(t, "https://hooks.slack.com/services/A/B/C", got["webhook_url"])
	require.Equal(t, payload.Text, got["text"])
}

func TestBuildEnvelopesForConfig_DiscordMixedVariants(t *testing.T) {
	cfg := db.NotificationConfig{
		ChannelID: "discord",
		Credentials: json.RawMessage(`{
			"webhooks":[{"url":"https://discord.com/api/webhooks/1/token"}],
			"bot_token":"bot-token",
			"channels":[{"channel_id":"chan-1"},{"channel_id":""}],
			"users":[{"user_id":"user-1"},{"user_id":""}]
		}`),
	}

	envelopes, err := buildEnvelopesForConfig(cfg, NotificationPayload{Text: utils.Ptr("hello")})
	require.NoError(t, err)
	require.Len(t, envelopes, 3)

	webhook := envelopes[0].envelope.Payload.(map[string]any)
	require.Equal(t, "webhook", webhook["type"])
	require.Equal(t, "https://discord.com/api/webhooks/1/token", webhook["webhook_url"])

	channel := envelopes[1].envelope.Payload.(map[string]any)
	require.Equal(t, "bot_channel", channel["type"])
	require.Equal(t, "chan-1", channel["channel_id"])
	require.Equal(t, "bot-token", channel["bot_token"])

	user := envelopes[2].envelope.Payload.(map[string]any)
	require.Equal(t, "bot_user", user["type"])
	require.Equal(t, "user-1", user["user_id"])
}

func TestBuildDiscordEnvelopes_NoBotTokenAndNilText(t *testing.T) {
	now := time.Date(2026, 6, 17, 10, 0, 0, 0, time.UTC)
	raw := json.RawMessage(`{"channels":[{"channel_id":"chan-1"}],"users":[{"user_id":"user-1"}]}`)

	envelopes, err := buildDiscordEnvelopes(raw, NotificationPayload{}, now)
	require.NoError(t, err)
	require.Len(t, envelopes, 2)

	channel := envelopes[0].envelope.Payload.(map[string]any)
	require.Equal(t, "", channel["content"])
	require.NotContains(t, channel, "bot_token")
	require.NotContains(t, envelopes[1].envelope.Payload.(map[string]any), "bot_token")
}

func TestBuildTelegramEnvelopes(t *testing.T) {
	now := time.Date(2026, 6, 17, 10, 0, 0, 0, time.UTC)
	raw := json.RawMessage(`{"bot_token":"tg-token","chats":[{"chat_id":"chat-1"},{"chat_id":""}]}`)

	envelopes, err := buildTelegramEnvelopes(raw, NotificationPayload{}, now)
	require.NoError(t, err)
	require.Len(t, envelopes, 1)
	require.Equal(t, RoutingKeyTelegram, envelopes[0].routingKey)
	payload := envelopes[0].envelope.Payload.(map[string]any)
	require.Equal(t, "chat-1", payload["chat_id"])
	require.Equal(t, "tg-token", payload["bot_token"])
}

func TestBuildEnvelopesForConfig_InvalidCases(t *testing.T) {
	cases := []db.NotificationConfig{
		{ChannelID: "email", Credentials: json.RawMessage(`{"recipients":`)},
		{ChannelID: "slack", Credentials: json.RawMessage(`{"webhooks":`)},
		{ChannelID: "discord", Credentials: json.RawMessage(`{"webhooks":`)},
		{ChannelID: "telegram", Credentials: json.RawMessage(`{"chats":`)},
		{ChannelID: "webhook", Credentials: json.RawMessage(`{"endpoints":`)},
		{ChannelID: "pagerduty", Credentials: json.RawMessage(`{}`)},
	}
	for _, cfg := range cases {
		_, err := buildEnvelopesForConfig(cfg, NotificationPayload{})
		require.Error(t, err)
	}
}

func TestSend_ReturnsLoaderError(t *testing.T) {
	n := NewNotifier(fakeConfigSource{err: errors.New("boom")}, newFakePublisher(), testLogger())
	err := n.Send(context.Background(), "user-1", NotificationPayload{})
	require.ErrorContains(t, err, "load notification configs")
}

func TestSend_NoConfigsIsNoop(t *testing.T) {
	pub := newFakePublisher()
	n := NewNotifier(fakeConfigSource{}, pub, testLogger())
	require.NoError(t, n.Send(context.Background(), "user-1", NotificationPayload{}))
	require.Zero(t, pub.count(RoutingKeyEmail))
}

func TestSend_SkipsInvalidAndAggregatesFailures(t *testing.T) {
	configs := []db.NotificationConfig{
		{ID: "bad", ChannelID: "email", Credentials: json.RawMessage(`{"recipients":`)},
		{ID: "email", ChannelID: "email", Credentials: json.RawMessage(`{"recipients":[{"email":"a@example.com"}]}`)},
		{ID: "slack", ChannelID: "slack", Credentials: json.RawMessage(`{"webhooks":[{"url":"https://hooks.slack.com/services/A/B/C"}]}`)},
	}
	pub := newFakePublisher(RoutingKeyEmail) // email publishes fail
	n := NewNotifier(fakeConfigSource{configs: configs}, pub, testLogger())

	err := n.Send(context.Background(), "user-1", NotificationPayload{Subject: "subject", Text: utils.Ptr("hello")})
	require.ErrorContains(t, err, "1/2 notification publishes failed")
	require.Equal(t, 1, pub.count(RoutingKeyEmail))
	require.Equal(t, 1, pub.count(RoutingKeySlack))
}

func TestBuildSlackEnvelopes_AddsAnImageBlock(t *testing.T) {
	imageURL := "https://cdn.test/diff.png"
	text := "The appearance of \"Acme\" has changed."
	creds := json.RawMessage(`{"webhooks":[{"url":"https://hooks.slack.com/services/T/B/xxxxxxxxxxxxxxxxxxxxxxxx"}]}`)

	got, err := buildSlackEnvelopes(creds, NotificationPayload{
		Subject:  "[WatchThatSite] Visual change detected: Acme",
		Text:     &text,
		ImageURL: &imageURL,
	}, time.Now())

	require.NoError(t, err)
	require.Len(t, got, 1)

	payload, ok := got[0].envelope.Payload.(map[string]any)
	require.True(t, ok)

	blocks, ok := payload["blocks"].([]map[string]any)
	require.True(t, ok, "expected Block Kit blocks when an image is present")
	require.Len(t, blocks, 2)
	require.Equal(t, "image", blocks[1]["type"])
	require.Equal(t, imageURL, blocks[1]["image_url"])
	// text stays as the fallback/notification summary.
	require.Equal(t, &text, payload["text"])
}

func TestBuildSlackEnvelopes_OmitsBlocksWithoutAnImage(t *testing.T) {
	text := "The content of \"Acme\" has changed."
	creds := json.RawMessage(`{"webhooks":[{"url":"https://hooks.slack.com/services/T/B/xxxxxxxxxxxxxxxxxxxxxxxx"}]}`)

	got, err := buildSlackEnvelopes(creds, NotificationPayload{Subject: "s", Text: &text}, time.Now())

	require.NoError(t, err)
	require.Len(t, got, 1)
	payload, ok := got[0].envelope.Payload.(map[string]any)
	require.True(t, ok)
	require.NotContains(t, payload, "blocks")
}

func TestBuildWebhookEnvelopes(t *testing.T) {
	body := []byte(`{"id":"c1","monitor":{"name":"<A & B>"}}`)
	payload := NotificationPayload{Subject: "s", Webhook: body, WebhookEvent: "change"}
	cfg := db.NotificationConfig{
		ChannelID:   "webhook",
		Credentials: json.RawMessage(`{"endpoints":[{"url":"https://hooks.example.com/a","secret":"sek"},{"url":""}]}`),
	}
	envelopes, err := buildEnvelopesForConfig(cfg, payload)
	require.NoError(t, err)
	require.Len(t, envelopes, 1)
	require.Equal(t, RoutingKeyWebhook, envelopes[0].routingKey)
	require.Equal(t, channelWebhook, envelopes[0].envelope.Channel)
	got := envelopes[0].envelope.Payload.(map[string]any)
	require.Equal(t, "https://hooks.example.com/a", got["url"])
	require.Equal(t, "sek", got["secret"])
	require.Equal(t, "change", got["event"])

	// The body survives the broker's JSON encoding byte for byte.
	wire, err := json.Marshal(envelopes[0].envelope)
	require.NoError(t, err)
	var decoded struct {
		Payload struct {
			Body string `json:"body"`
		} `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(wire, &decoded))
	require.Equal(t, string(body), decoded.Payload.Body)
	require.Contains(t, RoutingKeys(), RoutingKeyWebhook)
}

func TestBuildWebhookEnvelopes_LegacyPayload(t *testing.T) {
	envelopes, err := buildWebhookEnvelopes(json.RawMessage(`{"endpoints":[{"url":"https://x.test","secret":"s"}]}`),
		NotificationPayload{Subject: "subj", Text: utils.Ptr("hello")}, time.Now())
	require.NoError(t, err)
	got := envelopes[0].envelope.Payload.(map[string]any)
	require.Equal(t, "notification", got["event"])
	require.JSONEq(t, `{"event":"notification","subject":"subj","text":"hello"}`, got["body"].(string))
}

func TestBuildEnvelopes_PreRenderedBodies(t *testing.T) {
	payload := NotificationPayload{
		Subject:  "s",
		Text:     utils.Ptr("plain"),
		Slack:    json.RawMessage(`{"text":"fallback","blocks":[{"type":"header","text":{"type":"plain_text","text":"H"}}]}`),
		Discord:  json.RawMessage(`{"content":"c","embeds":[{"title":"T","image":{"url":"https://img.test/a.png"}}]}`),
		Telegram: &TelegramBody{Text: "<b>t</b>", PhotoURL: "https://img.test/a.png", Caption: "cap"},
	}

	slack, err := buildSlackEnvelopes(json.RawMessage(`{"webhooks":[{"url":"https://hooks.slack.com/x"}]}`), payload, time.Now())
	require.NoError(t, err)
	sp := slack[0].envelope.Payload.(map[string]any)
	require.Equal(t, "fallback", sp["text"])
	require.JSONEq(t, `[{"type":"header","text":{"type":"plain_text","text":"H"}}]`, string(sp["blocks"].(json.RawMessage)))

	discord, err := buildDiscordEnvelopes(json.RawMessage(`{"webhooks":[{"url":"https://discord.com/api/webhooks/1/x"}],"channels":[{"channel_id":"c1"}]}`), payload, time.Now())
	require.NoError(t, err)
	require.Len(t, discord, 2)
	for _, e := range discord {
		dp := e.envelope.Payload.(map[string]any)
		require.Equal(t, "c", dp["content"])
		require.Contains(t, string(dp["embeds"].(json.RawMessage)), "https://img.test/a.png")
	}

	tg, err := buildTelegramEnvelopes(json.RawMessage(`{"chats":[{"chat_id":"1"}]}`), payload, time.Now())
	require.NoError(t, err)
	tp := tg[0].envelope.Payload.(map[string]any)
	require.Equal(t, "<b>t</b>", tp["text"])
	require.Equal(t, "HTML", tp["parse_mode"])
	require.Equal(t, "https://img.test/a.png", tp["photo_url"])
	require.Equal(t, "cap", tp["caption"])
}

func TestBuildDiscordEnvelopes_LegacyImageBecomesEmbed(t *testing.T) {
	img := "https://img.test/d.png"
	envelopes, err := buildDiscordEnvelopes(json.RawMessage(`{"webhooks":[{"url":"https://discord.com/api/webhooks/1/x"}]}`),
		NotificationPayload{Text: utils.Ptr("hi"), ImageURL: &img}, time.Now())
	require.NoError(t, err)
	dp := envelopes[0].envelope.Payload.(map[string]any)
	require.JSONEq(t, `[{"image":{"url":"https://img.test/d.png"}}]`, string(dp["embeds"].(json.RawMessage)))
}
