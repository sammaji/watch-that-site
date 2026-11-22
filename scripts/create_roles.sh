#!/usr/bin/env bash

set -euo pipefail

. ./scripts/is_root.sh
. ./scripts/require_envs.sh

only_allow_git_root

source ./.env

require_envs POSTGRES_DATABASE POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD

DB_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}"

psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;

  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
SQL

echo "INFO: PostgREST roles are ready."
