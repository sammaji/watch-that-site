package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/bytedance/sonic"
)

// Handler is implemented by every notification channel.
type Handler interface {
	// Channel returns the routing key this handler owns (e.g. "email").
	Channel() string

	// Validate checks whether the notification payload is well-formed for this
	// handler. It may also normalize the payload in-place, such as trimming
	// whitespace from target fields; implementations that mutate or read payload
	// state should use the notification's RWMutex.
	//
	// Validation errors should generally be permanent.
	Validate(n *Notification) *HandlerError

	// Send delivers the notification. Implementations must be safe for
	// concurrent use, the consumer calls Send from multiple goroutines.
	//
	// Return Transient errors for recoverable failures (network blip, rate limit).
	// The consumer will NACK with requeue=true and the message re-enters the queue.
	//
	// Return Permanent errors for unrecoverable failures (bad recipient,
	// malformed payload). The consumer will NACK with requeue=false so the message
	// is routed to the dead-letter queue.
	Send(ctx context.Context, n *Notification) *HandlerError
}

// HandlerError is returned by Handler.Send and Handler.Validate
//
// Transient errors (IsPermanent=false) are recoverable failures (network blip, rate limit).
// The consumer will NACK with requeue=true and the message re-enters the queue.
//
// Permanent errors (IsPermanent=true) are unrecoverable failures (bad recipient, malformed payload).
// The consumer will NACK with requeue=false so the message is routed to the
// dead-letter queue.
type HandlerError struct {
	Channel     string
	Msg         error
	IsPermanent bool
}

func (e *HandlerError) Error() string {
	return e.Msg.Error()
}

// ErrorPermanentf returns a permanent error.
func ErrorPermanentf(channel, format string, args ...any) *HandlerError {
	return &HandlerError{
		Channel:     channel,
		Msg:         fmt.Errorf(format, args...),
		IsPermanent: true,
	}
}

// ErrorTransientf returns a transient error.
func ErrorTransientf(channel, format string, args ...any) *HandlerError {
	return &HandlerError{
		Channel:     channel,
		Msg:         fmt.Errorf(format, args...),
		IsPermanent: false,
	}
}

type NoticationChannel string

// Channel constants (must match RabbitMQ routing keys)
const (
	ChannelEmail    NoticationChannel = "notifications.email"
	ChannelSlack    NoticationChannel = "notifications.slack"
	ChannelDiscord  NoticationChannel = "notifications.discord"
	ChannelTelegram NoticationChannel = "notifications.telegram"
	ChannelWebhook  NoticationChannel = "notifications.webhook"
)

// Notification is the envelope published to every queue.
// Each message carries exactly one channel-specific payload.
type Notification struct {
	Mu        sync.RWMutex `json:"-"`
	Channel   string       `json:"channel"`
	CreatedAt time.Time    `json:"created_at"`

	*EmailPayload    `json:"-"`
	*SlackPayload    `json:"-"`
	*DiscordPayload  `json:"-"`
	*TelegramPayload `json:"-"`
	*WebhookPayload  `json:"-"`
}

func (n *Notification) UnmarshalJSON(data []byte) error {
	var envelope struct {
		Channel   string          `json:"channel"`
		CreatedAt time.Time       `json:"created_at"`
		Payload   json.RawMessage `json:"payload"`
	}
	if err := sonic.Unmarshal(data, &envelope); err != nil {
		return err
	}

	n.Channel = envelope.Channel
	n.CreatedAt = envelope.CreatedAt

	switch NoticationChannel(envelope.Channel) {
	case ChannelEmail:
		if len(envelope.Payload) == 0 {
			return nil
		}
		var payload EmailPayload
		if err := sonic.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		n.EmailPayload = &payload
	case ChannelSlack:
		if len(envelope.Payload) == 0 {
			return nil
		}
		var payload SlackPayload
		if err := sonic.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		n.SlackPayload = &payload
	case ChannelDiscord:
		if len(envelope.Payload) == 0 {
			return nil
		}
		var payload DiscordPayload
		if err := sonic.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		n.DiscordPayload = &payload
	case ChannelTelegram:
		if len(envelope.Payload) == 0 {
			return nil
		}
		var payload TelegramPayload
		if err := sonic.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		n.TelegramPayload = &payload
	case ChannelWebhook:
		if len(envelope.Payload) == 0 {
			return nil
		}
		var payload WebhookPayload
		if err := sonic.Unmarshal(envelope.Payload, &payload); err != nil {
			return err
		}
		n.WebhookPayload = &payload
	}

	return nil
}

type EmailPayload struct {
	Subject     string             `json:"subject"`
	Reciever    string             `json:"reciever"`
	Text        *string            `json:"text,omitempty"`
	Html        *string            `json:"html,omitempty"`
	Attachments []*EmailAttachment `json:"attachments,omitempty"`
}

type EmailAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Data        []byte `json:"data"` // base64-decoded by the publisher
}

type SlackPayload struct {
	WebhookURL string       `json:"webhook_url"`
	Text       *string      `json:"text,omitempty"`
	Blocks     []SlackBlock `json:"blocks,omitempty"`
}

type SlackBlockType string

const (
	SlackBlockTypeActions  SlackBlockType = "actions"
	SlackBlockTypeContext  SlackBlockType = "context"
	SlackBlockTypeDivider  SlackBlockType = "divider"
	SlackBlockTypeFile     SlackBlockType = "file"
	SlackBlockTypeHeader   SlackBlockType = "header"
	SlackBlockTypeImage    SlackBlockType = "image"
	SlackBlockTypeInput    SlackBlockType = "input"
	SlackBlockTypeRichText SlackBlockType = "rich_text"
	SlackBlockTypeSection  SlackBlockType = "section"
	SlackBlockTypeVideo    SlackBlockType = "video"
)

type SlackBlock struct {
	Type      SlackBlockType `json:"type"`
	BlockID   string         `json:"block_id,omitempty"`
	Text      *SlackText     `json:"text,omitempty"`
	Fields    []SlackText    `json:"fields,omitempty"`
	Elements  []SlackElement `json:"elements,omitempty"`
	Accessory *SlackElement  `json:"accessory,omitempty"`
	ImageURL  string         `json:"image_url,omitempty"`
	AltText   string         `json:"alt_text,omitempty"`
}

type SlackText struct {
	Type     SlackTextType `json:"type"`
	Text     string        `json:"text"`
	Emoji    *bool         `json:"emoji,omitempty"`
	Verbatim *bool         `json:"verbatim,omitempty"`
}

type SlackTextType string

const (
	SlackTextTypeMrkdwn    SlackTextType = "mrkdwn"
	SlackTextTypePlainText SlackTextType = "plain_text"
)

type SlackElement struct {
	Type     SlackElementType `json:"type"`
	ActionID string           `json:"action_id,omitempty"`
	Text     *SlackText       `json:"text,omitempty"`
	Value    string           `json:"value,omitempty"`
	URL      string           `json:"url,omitempty"`
	Elements []SlackElement   `json:"elements,omitempty"`
	ImageURL string           `json:"image_url,omitempty"`
	AltText  string           `json:"alt_text,omitempty"`
	Style    string           `json:"style,omitempty"`
	Confirm  *SlackConfirm    `json:"confirm,omitempty"`
}

type SlackElementType string

const (
	SlackElementTypeBroadcast                SlackElementType = "broadcast"
	SlackElementTypeButton                   SlackElementType = "button"
	SlackElementTypeChannelsSelect           SlackElementType = "channels_select"
	SlackElementTypeCheckboxes               SlackElementType = "checkboxes"
	SlackElementTypeColor                    SlackElementType = "color"
	SlackElementTypeConversationsSelect      SlackElementType = "conversations_select"
	SlackElementTypeDate                     SlackElementType = "date"
	SlackElementTypeDatepicker               SlackElementType = "datepicker"
	SlackElementTypeDatetimepicker           SlackElementType = "datetimepicker"
	SlackElementTypeEmailTextInput           SlackElementType = "email_text_input"
	SlackElementTypeEmoji                    SlackElementType = "emoji"
	SlackElementTypeExternalSelect           SlackElementType = "external_select"
	SlackElementTypeImage                    SlackElementType = "image"
	SlackElementTypeLink                     SlackElementType = "link"
	SlackElementTypeMultiChannelsSelect      SlackElementType = "multi_channels_select"
	SlackElementTypeMultiConversationsSelect SlackElementType = "multi_conversations_select"
	SlackElementTypeMultiExternalSelect      SlackElementType = "multi_external_select"
	SlackElementTypeMultiStaticSelect        SlackElementType = "multi_static_select"
	SlackElementTypeMultiUsersSelect         SlackElementType = "multi_users_select"
	SlackElementTypeNumberInput              SlackElementType = "number_input"
	SlackElementTypeOverflow                 SlackElementType = "overflow"
	SlackElementTypePlainTextInput           SlackElementType = "plain_text_input"
	SlackElementTypeRadioButtons             SlackElementType = "radio_buttons"
	SlackElementTypeRichTextInput            SlackElementType = "rich_text_input"
	SlackElementTypeRichTextList             SlackElementType = "rich_text_list"
	SlackElementTypeRichTextPreformatted     SlackElementType = "rich_text_preformatted"
	SlackElementTypeRichTextQuote            SlackElementType = "rich_text_quote"
	SlackElementTypeRichTextSection          SlackElementType = "rich_text_section"
	SlackElementTypeStaticSelect             SlackElementType = "static_select"
	SlackElementTypeText                     SlackElementType = "text"
	SlackElementTypeTimepicker               SlackElementType = "timepicker"
	SlackElementTypeURLTextInput             SlackElementType = "url_text_input"
	SlackElementTypeUser                     SlackElementType = "user"
	SlackElementTypeUsergroup                SlackElementType = "usergroup"
	SlackElementTypeUsersSelect              SlackElementType = "users_select"
	SlackElementTypeWorkflowButton           SlackElementType = "workflow_button"
)

type SlackConfirm struct {
	Title   SlackText `json:"title"`
	Text    SlackText `json:"text"`
	Confirm SlackText `json:"confirm"`
	Deny    SlackText `json:"deny"`
}

type DiscordDeliveryType string

const (
	DiscordDeliveryTypeWebhook    DiscordDeliveryType = "webhook"
	DiscordDeliveryTypeBotChannel DiscordDeliveryType = "bot_channel"
	DiscordDeliveryTypeBotUser    DiscordDeliveryType = "bot_user"
)

type DiscordPayload struct {
	Type    DiscordDeliveryType `json:"type"`
	Content string              `json:"content"`
	// Embeds is a pre-rendered Discord embeds array, sent verbatim.
	Embeds     json.RawMessage `json:"embeds,omitempty"`
	WebhookURL string          `json:"webhook_url,omitempty"`
	BotToken   *string         `json:"bot_token,omitempty"`
	ChannelID  string          `json:"channel_id,omitempty"`
	UserID     string          `json:"user_id,omitempty"`
}

type TelegramParseMode string

const (
	TelegramParseModeHTML       TelegramParseMode = "HTML"
	TelegramParseModeMarkdownV2 TelegramParseMode = "MarkdownV2"
)

type TelegramPayload struct {
	Text      string            `json:"text"`
	ChatID    string            `json:"chat_id"`
	BotToken  *string           `json:"bot_token,omitempty"`
	ParseMode TelegramParseMode `json:"parse_mode,omitempty"`
	// PhotoURL, when set, is sent first via sendPhoto with Caption (same
	// parse mode); Text, if any, follows as a message.
	PhotoURL string `json:"photo_url,omitempty"`
	Caption  string `json:"caption,omitempty"`
}

// WebhookPayload is one signed POST to a user's endpoint. Body is sent
// byte for byte; it travels as a JSON string so the bytes survive the queue.
type WebhookPayload struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
	// Event is sent as X-WatchThatSite-Event ("change", "digest",
	// "element_not_found", …).
	Event string `json:"event"`
	Body  string `json:"body"`
}
