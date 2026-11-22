#!/usr/bin/env bash

set -euo pipefail

. ./scripts/is_root.sh
. ./scripts/require_envs.sh

only_allow_git_root

source ./.env

require_envs POSTGRES_DATABASE POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD

SQL_DIR="$GIT_ROOT/packages/db/migrations"
DB_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}?sslmode=disable"

if [ ! -d "$SQL_DIR" ]; then
    echo "ERROR: Missing migration directory: $SQL_DIR" >&2
    exit 1
fi

cd "$GIT_ROOT/scripts/migrator"
DATABASE_URL="$DB_URL" go run . -dir "$SQL_DIR"
