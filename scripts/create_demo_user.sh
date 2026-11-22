#!/usr/bin/env bash
# Creates a verified demo account in the local stack, so you can sign in
# without email. Safe to run again. Needs the web app (make dev) and Postgres.
#   make demo-user                      # demo@watchthatsite.local / watchthatsite-demo
#   DEMO_EMAIL=... DEMO_PASSWORD=... make demo-user
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

EMAIL="${DEMO_EMAIL:-demo@watchthatsite.local}"
PASSWORD="${DEMO_PASSWORD:-watchthatsite-demo}"
NAME="${DEMO_NAME:-Demo User}"
APP="${NEXT_PUBLIC_APP_URL:-http://localhost:3000}"

if ! curl -s -o /dev/null "$APP/login"; then
  echo "The web app is not answering at $APP. Start it with 'make dev' first." >&2
  exit 1
fi

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP/api/auth/sign-up/email" \
  -H "content-type: application/json" -H "origin: $APP" \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}")
case "$status" in
  200) echo "Account ready: $EMAIL." ;;
  422|400) echo "$EMAIL already exists." ;;
  *) echo "Sign-up answered HTTP $status." >&2; exit 1 ;;
esac

docker exec -i watchthatsite-postgres psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DATABASE" \
  -c "UPDATE users SET email_verified = true WHERE email = '$EMAIL';" >/dev/null

echo "Sign in at $APP/login with $EMAIL / $PASSWORD"
