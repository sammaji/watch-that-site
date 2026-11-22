# Email Notification E2E Setup

These tests exercise the Go notification worker end to end:

1. start a local webhook receiver
2. receive Resend webhook events on a deterministic path
3. publish concrete single-target messages to RabbitMQ
4. assert Resend webhook events and RabbitMQ DLQ behavior

## Prerequisites

- RabbitMQ is running with the notification queues from `infra/rabbitmq/definitions.template.json`.
- The Go notification worker is already running.
- A public HTTPS tunnel forwards to the local webhook receiver.

## Environment

Set these in `/Users/levi/wksp/watchthatsite/.env` or `/Users/levi/wksp/watchthatsite/tests/.env`:

```bash
RABBITMQ_USER=...
RABBITMQ_PASSWORD=...

SMTP_MAIL=...
SMTP_SENDER_NAME=...

# Optional. Use this when your tunnel forwards to a fixed local port.
TEST_RESEND_WEBHOOK_PORT=8787
```

## Start Infra

```bash
cd /Users/levi/wksp/watchthatsite/infra
docker compose up -d watchthatsite-rabbitmq
```

## Start The Notification Worker

The tests do not start the worker. Start it in a separate terminal before running the suite:

```bash
cd /Users/levi/wksp/watchthatsite/services/notifications
go run ./cmd
```

## Resend Webhook Setup

Create a Resend webhook in the Resend dashboard that points to your public tunnel URL plus this deterministic path:

```text
https://example-tunnel.ngrok.app/resend-webhook
```

The webhook should listen for:

- `email.sent`
- `email.delivered`
- `email.bounced`
- `email.failed`

Resend requires a publicly reachable HTTPS endpoint for webhooks. For local runs, forward your tunnel to `TEST_RESEND_WEBHOOK_PORT` or the random port chosen by the test process if you omit it.

The suite uses Resend test recipients:

- `delivered+...@resend.dev` for successful sends
- `bounced+...@resend.dev` for bounce behavior
- an invalid address for worker validation / DLQ behavior

## Run

```bash
pnpm --dir /Users/levi/wksp/watchthatsite/tests test:e2e:notifications
```
