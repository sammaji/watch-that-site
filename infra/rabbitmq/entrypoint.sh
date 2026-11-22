#!/bin/sh
set -e

sed \
  -e "s/\${RABBITMQ_USER}/${RABBITMQ_USER}/g" \
  -e "s/\${RABBITMQ_PASSWORD}/${RABBITMQ_PASSWORD}/g" \
  /etc/rabbitmq/definitions.template.json > /tmp/definitions.json

echo "==> definitions.json generated:"
cat /tmp/definitions.json

exec docker-entrypoint.sh rabbitmq-server "$@"