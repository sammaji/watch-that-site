#!/usr/bin/env bash

set -euo pipefail

. ./scripts/is_root.sh
. ./scripts/require_envs.sh

only_allow_git_root

source ./.env

require_envs BETTER_AUTH_URL

ENV_FILE="$GIT_ROOT/.env"
TEMP_ENV_FILE="$GIT_ROOT/.env.temp"
JWKS_URL="${BETTER_AUTH_URL}/api/auth/jwks"
OVERWRITE="${OVERWRITE:-false}"

get_env_value() {
    local var_key="$1"
    local file="$2"

    if [ -f "$file" ]; then
        grep "^${var_key}=" "$file" 2>/dev/null | cut -d'=' -f2-
    fi
}

existing_value=$(get_env_value "PGRST_JWT_SECRET" "$ENV_FILE")

if [ -n "$existing_value" ] && [ "$OVERWRITE" = false ]; then
    echo "INFO: PGRST_JWT_SECRET already has a value. Skipping."
    exit 0
fi

echo "INFO: Waiting for Better Auth JWKS at $JWKS_URL"
timeout=120

until curl -sf "$JWKS_URL" >/dev/null; do
    timeout=$((timeout - 1))

    if [ "$timeout" -le 0 ]; then
        echo "ERROR: Timed out waiting for $JWKS_URL" >&2
        exit 1
    fi

    sleep 1
done

jwks_response=$(curl -sf "$JWKS_URL")

awk -v key="PGRST_JWT_SECRET" -v value="$jwks_response" '
{
    if ($0 ~ ("^" key "=")) {
        print key "=" value;
        next;
    }
    print $0;
}
' "$ENV_FILE" > "$TEMP_ENV_FILE"

mv "$TEMP_ENV_FILE" "$ENV_FILE"

echo "INFO: PGRST_JWT_SECRET updated in .env."
