# WatchThatSite

@AGENTS.md

`AGENTS.md` is the source of truth for the setup: prerequisites, environment variables, commands to install and start everything, test logins, and the journeys to try end to end. Keep it current when any of those change.

## Working in this repo

- Configuration is the repo-root `.env` only; each app's `.env` is a symlink to it. Add new variables to `.env.example` (and to `scripts/post_install.sh` if they can be generated).
- The database has a single schema file, `packages/db/migrations/schema.sql`, with no dated migrations. `functions.sql` and `rls.sql` are re-applied on every `make migrate`.
- The browser reads data through PostgREST under row-level security. Anything touching a key or secret goes through the web app's API routes, and model calls only go through Bifrost with the account's virtual key.
- Ports: web 3000, site 3001, docs 3002, sample pages 3003, Postgres 5200, PostgREST 5201, proxy 5202, Bifrost 5203, scheduler admin 5210, agent API 5220, object store 8787.
- Issues live as GitHub issues in `sammaji/watchthatsite`; use the `gh` CLI.
- Never commit `.env`, `.dev.vars` or any key.
