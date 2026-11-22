# Notification Worker

## Overview

The `notifications` service is a Go worker that delivers notifications to external channels. It consumes messages from five RabbitMQ queues over **AMQP 1.0** using `github.com/rabbitmq/rabbitmq-amqp-go-client`, the same client the scheduler uses, validates each payload, and delivers it through the channel's provider.

Supported channels:

- **Email** via the Resend API
- **Slack** via incoming webhooks
- **Discord** via webhook, bot channel message, or bot direct message
- **Telegram** via the Bot API
- **Webhook** via a signed HTTPS `POST` to a user-supplied endpoint

The service is stateless. It opens no database connection and exposes no HTTP surface. It also declares no broker topology: exchanges, queues, and bindings are pre-provisioned from `infra/rabbitmq/definitions.template.json`.

## Core Architecture

**Startup.** The composition root builds a JSON `slog` logger at `LOG_LEVEL`, loads shared configuration, installs a signal-aware root context, and connects to RabbitMQ with retry (10 attempts, 1s backoff doubling to a 30s cap). It then builds the queue-to-handler mapping with per-channel worker counts, runs the router until the context is cancelled, and closes the connection under a 10-second deadline.

**Router.** Owns the single AMQP connection and supervises one consumer goroutine per queue. If a consumer's receiver link dies, that channel is restarted with exponential backoff (1s doubling to 30s) while the other channels keep running. The client performs its own connection recovery underneath; if a consumer still cannot be reopened, the error is connection-level and therefore fatal, so the worker exits and relies on an external process manager to restart it.

**Consumer.** Each channel has a dedicated consumer holding one receiver link. Initial link credits equal that channel's worker count, so the number of unsettled deliveries never exceeds the pool that can process them, applying backpressure at the broker. Deliveries are dispatched to a semaphore-bounded goroutine pool, and each delivery is settled exactly once.

**Handlers.** Every channel implements a two-stage contract: `Validate` checks and normalizes the payload, then `Send` performs the outbound provider call. Both return an error tagged permanent or transient, and that tag is what drives settlement.

```text
    +-------------------------------------------------------+
    |                        RabbitMQ                       |
    |                notifications (exchange)               |
    +-------------------------------------------------------+
        |               |               |               |
      email           slack          discord        telegram     (+ webhook)
        |               |               |               |
        v               v               v               v
+----------------------------------------------------------------+
|                      Router (one connection)                    |
|   supervises one consumer goroutine per queue, restarts with    |
|   exponential backoff on receiver-link failure                  |
+----------------------------------------------------------------+
        |               |               |               |
        v               v               v               v
  +-----------+   +-----------+   +-----------+   +-----------+
  | Consumer  |   | Consumer  |   | Consumer  |   | Consumer  |
  | credits=5 |   | credits=2 |   | credits=2 |   | credits=3 |
  +-----------+   +-----------+   +-----------+   +-----------+
        |               |               |               |
        v               v               v               v
  +-----------+   +-----------+   +-----------+   +-----------+
  |   Email   |   |   Slack   |   |  Discord  |   | Telegram  |
  |  handler  |   |  handler  |   |  handler  |   |  handler  |
  +-----------+   +-----------+   +-----------+   +-----------+
        |               |               |               |
        v               v               v               v
   Resend API     Slack webhook    Discord API    Telegram API

  settlement: accept (delivered) | release (transient) | reject (permanent)
  reject --> dlq exchange --> dlq.notifications
```

## End-to-End Workflow

1. A publisher routes a notification through the `notifications` direct exchange on the channel's routing key, landing it in one of the five durable quorum queues.
2. The matching consumer receives the delivery within its credit window and hands it to a worker from that channel's pool.
3. The worker decodes the JSON envelope and selects the channel-specific payload.
4. The channel handler validates the payload, normalizing fields along the way, such as trimming the email recipient or filling in the service-default bot token when the payload omits one.
5. The handler performs the outbound provider call, bound to the service context so shutdown cancels it.
6. On success the delivery is accepted and removed from the queue.

Failure paths:

- **Undecodable JSON** is rejected immediately, so the queue's dead-letter exchange moves it to `dlq.notifications`.
- **Validation failures and unrecoverable provider responses** (invalid credentials, missing or deleted target, malformed request) are rejected and dead-lettered.
- **Recoverable failures** (network errors, rate limits, provider 5xx) are released back to the queue for redelivery.
- **A dropped receiver link** restarts only that channel's consumer, with exponential backoff.
- **On `SIGINT` or `SIGTERM`** the root context is cancelled, each consumer stops receiving and waits for its in-flight workers, and the connection closes under a 10-second deadline.

### Message Contract

Each message is a JSON envelope carrying exactly one channel-specific payload:

```json
{
  "channel": "notifications.email",
  "created_at": "2026-09-04T12:00:00Z",
  "payload": {
    "subject": "Your monitor detected a change",
    "reciever": "user@example.com",
    "text": "The page you are watching changed."
  }
}
```

The `channel` field carries the queue name (`notifications.email`), while the exchange routing key is the bare channel name (`email`).

## Features and Functionalities

- AMQP 1.0 transport, sharing the broker client used by the scheduler.
- Per-channel concurrency limits, with credit-based prefetch matched to the pool size.
- Startup connection retry with capped exponential backoff.
- Per-consumer restart with capped exponential backoff, isolated per channel.
- Two-stage handling (validate, then send) with permanent versus transient classification driving accept, release, or reject.
- Dead-lettering through the queue's dead-letter exchange rather than any in-service retry store.
- **Email**: Resend delivery, HTML and/or text body, RFC 5322 recipient validation, and attachments capped at 10 MB with a MIME allowlist (PDF, JPEG, PNG, GIF, WebP, plain text, CSV) plus a sniffed-content-type match check.
- **Slack**: incoming-webhook URL pattern validation and support for `text` and/or Block Kit blocks (maximum 50), with recursive validation of blocks, fields, elements, and confirm dialogs.
- **Discord**: three delivery modes (webhook, bot channel message, and bot direct message including channel opening), with a branded username and avatar on webhook posts.
- **Discord** messages may carry pre-rendered `embeds` (sent verbatim, up to 10); `content` may then be empty. The scheduler's renderer puts the diff in a ```` ```diff ```` block and the before/after crop in the embed image.
- **Telegram**: Bot API `sendMessage` with optional `HTML` or `MarkdownV2` parse mode, and a per-payload bot token that overrides the service default. When the payload has `photo_url`, the photo is sent first with `sendPhoto` and `caption` (same parse mode), then `text` if any. If Telegram refuses the photo permanently, the caption (or text) is sent as a plain message instead.
- **Webhook**: `POST {url}` with the payload's `body` byte for byte, `Content-Type: application/json`, `X-WatchThatSite-Event: {event}` (`change`, `digest`, `element_not_found`, `failure`) and `X-WatchThatSite-Signature: t={unix},v1={hex}` where `v1 = HMAC-SHA256(secret, "{t}.{body}")`. Only `https://` URLs are accepted; the client refuses private, loopback and link-local addresses, does not follow redirects and times out after 10 s. 2xx is success; 408, 429, 5xx and network errors are transient; other statuses (including 3xx) are permanent.
- Provider-specific rate-limit and status-code mapping on every channel.
- Structured JSON logging to stdout with per-queue and per-message context.

## Operational Notes

Queues consumed: `notifications.email`, `notifications.slack`, `notifications.discord`, `notifications.telegram`, `notifications.webhook`. Rejected messages dead-letter to `dlq.notifications`.

Concurrency is set per channel. Each variable controls both the worker pool size and the receiver link credits:

- `NOTIFICATION_SERVICE_EMAIL_WORKER_COUNT` (default: 5)
- `NOTIFICATION_SERVICE_SLACK_WORKER_COUNT` (default: 2)
- `NOTIFICATION_SERVICE_DISCORD_WORKER_COUNT` (default: 2)
- `NOTIFICATION_SERVICE_TELEGRAM_WORKER_COUNT` (default: 3)
- `NOTIFICATION_SERVICE_WEBHOOK_WORKER_COUNT` (default: 3)

Other environment variables:

- The broker URL is assembled by the shared core loader from `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `RABBITMQ_HOST`, and `RABBITMQ_PORT`.
- Email delivery requires `RESEND_API_KEY`, `SMTP_MAIL`, and `SMTP_SENDER_NAME`.
- `DISCORD_BOT_TOKEN` and `TELEGRAM_BOT_TOKEN` are optional service-wide defaults used when a payload omits its own token.
- The shared config loader also demands the `POSTGRES_*` variables and panics without them, even though this worker never opens a database connection.
- `LOG_LEVEL` controls verbosity.

Local end-to-end hooks (never set these in a deployed environment; the service logs a warning at startup when they are on):

- `EMAIL_TRANSPORT=capture` makes the email handler `POST` `{"to", "from", "subject", "html", "text"}` as JSON to `EMAIL_CAPTURE_URL` instead of calling Resend. `RESEND_API_KEY` must still be set (any value) because the shared config loader requires it.
- `NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS=localhost,127.0.0.1` lists hosts that local sinks run on. For those hosts only, Slack and Discord webhook URLs skip their `hooks.slack.com` / `discord.com` patterns, `http://` is accepted (Slack, Discord and webhook), and the webhook client's private-address guard is skipped. A Slack sink must answer `200` with the body `ok`. The web app mirrors this with `NEXT_PUBLIC_NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS`, which relaxes the settings form's URL patterns.

## Running Locally

To run the notification service locally during development, ensure the underlying infrastructure (RabbitMQ, Postgres) is running. You must also ensure that the `.env` file exists at `services/notifications/.env` (which is typically generated and symlinked by `make init` or `make setup-env`).

Use the Makefile at the root of the project to run it:

```bash
make run-notification-service
```

## Current Limitations

- Released messages are redelivered immediately with no delay, so a persistently failing transient error produces a hot redelivery loop for that message.
- Releasing a message does not increment the quorum queue's delivery count, so `x-delivery-limit` never caps transient retries. Only `notifications.discord` and `notifications.webhook` set that limit in the shipped definitions; the other three notification queues have none.
- Settlement during shutdown uses the cancelled context, so a delivery in flight when the signal arrives may go unsettled and be redelivered after restart. Delivery is at-least-once and handlers are not idempotent.
- The in-flight drain on shutdown is unbounded. A handler blocked on a provider call that ignores cancellation delays exit.
- A connection-level failure that survives the client's own recovery is fatal; restarting is left to the process manager.
- No health endpoint, metrics, or tracing. Observability is stdout logs only.
- Go tests cover the webhook, email-capture, Discord-embed, Telegram-photo and host-allowlist paths (`go test ./...`); the rest relies on the repository's Node end-to-end notification suite.
- Telegram photo delivery is two API calls; a transient failure of the second redelivers the whole message, so the photo can arrive twice.
- Webhook secrets travel inside queue messages, like the bot tokens already do.
- The service declares no topology, so it cannot consume if the broker definitions were never loaded.
