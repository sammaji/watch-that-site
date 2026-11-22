#!/usr/bin/env bash

if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

: "${RABBITMQ_USER:? 'Error: RABBITMQ_USER is not set.'}"
: "${RABBITMQ_PASSWORD:? 'Error: RABBITMQ_PASSWORD is not set.'}"

if [ -z "${TEST_NOTIFICATIONS_USER_ID:-}" ]; then
    echo "Error: TEST_NOTIFICATIONS_USER_ID must be set." >&2
    exit 1
fi

payload="$(jq -nc \
  --arg id "telegram-test-$(date +%s)" \
  --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg user_id "$TEST_NOTIFICATIONS_USER_ID" \
  '{
    id: $id,
    channel: "telegram",
    data: {
      text: "This is a manual test notification from RabbitMQ.",
    },
    created_at: $now
  }
  | .user_id = $user_id')"

curl -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" \
  -H "content-type: application/json" \
  -d "$(jq -nc --arg payload "$payload" '{
    properties: {
      delivery_mode: 2,
      content_type: "application/json"
    },
    routing_key: "telegram",
    payload: $payload,
    payload_encoding: "string"
  }')" \
  "http://localhost:15672/api/exchanges/%2F/notifications/publish"
