# WatchThatSite

Watch any web page and get told when something you care about changes. You give a Monitor a URL and instructions in plain words; an agent compares each new Capture of the page with the last one and decides whether the difference is a Change you asked about.

Every account starts with $10 of **WatchThatSite credit** for the models the agent uses, and can add its own provider keys as **connections**. All model calls go through a Bifrost gateway (see [Model gateway and connections](#model-gateway-and-connections)).

## How it fits together

What happens on a Run:

1. The **scheduler** finds the Monitors that are due and publishes a `ScrapeJob` for each to RabbitMQ.
2. The **browser worker** replays the Monitor's Macro (plain Playwright, no model), takes the Capture, stores the screenshot and text blocks through the object-store Worker, and publishes a `Capture`.
3. The scheduler diffs the Capture against the Baseline. If they are identical the Run ends there, with no model call.
4. If they differ, the scheduler calls the **agent API** (`POST /internal/compare`), which the browser worker serves. The agent reads the Monitor's instructions and the evidence, calls the model through the gateway with the account's virtual key, and answers: is this a Change, a summary, the items that changed, and what it ignored.
5. The scheduler records the verdict and the Change Record and hands Reactions to the **notifications** worker.

The pieces:

- **Web** (`apps/web`, :3000): the app. Sign-up, Monitors, the Change view, notification Channels, model connections. The browser reads data through PostgREST under row-level security; anything that touches a key goes through the app's own API routes.
- **Scheduler** (`services/scheduler`): decides which Monitors are due, publishes a `ScrapeJob` per Run, diffs each `Capture` that comes back against the Baseline, asks the agent when they differ, records the verdict and the Change Record, and fires Reactions. Its admin API (:5210) is what the web app calls for Run now.
- **Browser worker** (`services/browser-worker`): replays the Monitor's Macro, takes the Capture with Playwright and publishes it. It also serves the **agent API** (:5220): `POST /internal/compare` for the scheduler, and `POST /internal/macros/record` and `/internal/macros/test` for the web app. The agent is the only code that calls a model, always through the gateway, with the account's virtual key read from the vault: the scheduler never sees one.
- **Notifications** (`services/notifications`): delivers Changes to Email, Slack, Discord, Telegram and webhooks.
- **Object-store Worker** (`packages/cloudflare`, :8787): a Cloudflare Worker in front of the private R2 bucket that holds screenshots, text blocks and Change Records.
- **Postgres + PostgREST** (:5200, :5201) and **RabbitMQ** (:5672): the database, its REST API for the browser, and the queue between the scheduler and the workers.
- **Bifrost** (:5203, `infra/bifrost.config.json`): the model gateway every model call goes through. It holds the provider keys, one virtual key per account, and the platform credit as a budget.
- **Docs** (`apps/docs`, :3002), **marketing site** (`apps/site`, :3001), **sample pages** (`apps/sample-pages`, :3003, fixtures for the E2E suite) and the optional **proxy** (`services/proxy`, :5202).

## Prerequisites

- Node.js and `pnpm` 10.33+
- Go 1.26+
- Docker
- `make`

## Setup

```bash
make init
```

This creates `.env` from `.env.example` (generating the local secrets, including `ENCRYPTION_KEY`) and symlinks it into every app and service, sets up the Go workspace, installs JS dependencies, starts Postgres, PostgREST, RabbitMQ and the Bifrost gateway, applies the database schema, and gives PostgREST the web app's signing keys. Infra is left running.

Then fill in what `make init` cannot generate, in `.env`:

- `RESEND_API_KEY`, `SMTP_MAIL`: sign-up sends a verification email.
- `R2_API_TOKEN`, `R2_SIGNING_SECRET`: see [Object storage](#object-storage).
- `OPENAI_API_KEY`: the OpenAI key behind the platform credit. Run `make docker-up` again after setting it, so the gateway picks it up.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `DISCORD_*`, `TELEGRAM_BOT_TOKEN`: only for those sign-in methods and Channels.

Every variable is documented in `.env.example`.

## Running

```bash
make docker-up                              # Postgres, PostgREST, RabbitMQ, Bifrost
pnpm --filter @watchthatsite/cloudflare dev # object-store Worker on :8787
make dev                                    # web :3000, site :3001, docs :3002, sample pages :3003
make run-scheduler-service                  # scheduler, admin API on :5210
make run-browser-worker                     # browser worker, agent API on :5220
make run-notification-service               # notification worker
```

Each line after the first is a long-running process: give it its own terminal. `make help` lists every target.

Open <http://localhost:3000> and sign up. The account gets its WatchThatSite credit the first time it opens the app; **Connections** in the sidebar shows it, and is where own keys are added.

| Port | What |
| --- | --- |
| 3000 | Web app |
| 3001 | Marketing site |
| 3002 | Docs |
| 3003 | Sample pages (test fixtures) |
| 5200 | Postgres |
| 5201 | PostgREST |
| 5202 | Proxy (optional, `--profile services`) |
| 5203 | Bifrost model gateway (dashboard and API) |
| 5204, 5205 | MinIO S3 API and console (optional, `--profile storage`) |
| 5210 | Scheduler admin API |
| 5220 | Agent API (browser worker) |
| 5672, 15672 | RabbitMQ and its management UI |
| 8787 | Object-store Worker |

## Model gateway and connections

Every model call goes through **Bifrost** (`maximhq/bifrost:v2.6.0`, :5203, its own Postgres `watchthatsite-bifrost-postgres`), started by `make docker-up`. Its configuration is `infra/bifrost.config.json`; the dashboard and admin API need `BIFROST_ADMIN_USERNAME` / `BIFROST_ADMIN_PASSWORD`, and inference needs a virtual key.

- **One virtual key per account.** Created by the web app the first time a signed-in user opens the app or lists connections (`ensurePlatformConnection` in `apps/web/lib/connections/service.ts`), named `uuidv5(user id, 7ebd4589-03a9-40fa-8311-7a451255accb)` so it is stable and does not show the user id. Its value is the only credential the agent sends; it is sealed in the vault (`secrets`, purpose `virtual_key`) and recorded in `virtual_keys`. If Bifrost is down the app works without it and the next request tries again.
- **Platform credit.** Bifrost has a custom provider `wts` (OpenAI-compatible, our `OPENAI_API_KEY` as the key `wts-default-key`). Two routing rules turn `wts/wts-pro` into `gpt-6.2-astra` and `wts/wts-mini` into `gpt-6-luna` on that key. Each virtual key's `wts` provider config allows only those two routed models (Bifrost checks the routed model, not the alias) and carries the credit as its budget: `PLATFORM_CREDIT_USD` over `292Y`, the longest window Bifrost accepts, so in practice it never resets. Pricing overrides in the config price the two models on `wts` at OpenAI's list price, since Bifrost's catalog has no prices for a custom provider and the budget would otherwise never move. When the credit is spent, Bifrost answers 402 and the agent reports "Your WatchThatSite credit is used up. Add your own model connection to keep checking pages." The account's `provider_connections` row for it has `managed = true` and cannot be changed or deleted.
- **Own keys.** A connection the owner adds can be for any provider Bifrost supports for chat (OpenAI, Anthropic, Azure OpenAI, AWS Bedrock and Bedrock Mantle, Google Vertex AI and Gemini, Mistral, Groq, Cohere, Cerebras, Fireworks, xAI, OpenRouter, DeepSeek; the list, what each one asks for, and the providers left out on purpose (`EXCLUDED_PROVIDERS`) are in `apps/web/lib/connections/providers.ts`), or a custom OpenAI- or Anthropic-compatible endpoint. It becomes a key on that Bifrost provider, named after the connection id, with the provider's settings in its `<provider>_key_config` and Azure deployments or Bedrock inference profiles in `aliases`. A custom endpoint gets a custom provider of its own, `c-<16 hex digits of the connection id>`, at its URL. Secrets (API keys, AWS secret keys, service-account JSON) go only to Bifrost; we keep the non-secret settings (`provider_connections.settings`: endpoint, region, project, deployments) and the last four characters of the key, for display. Credentials that would run on the gateway's own identity are refused: Azure default credentials, Bedrock IAM roles, Vertex credentials other than a service-account key. The key is attached to the account's virtual key as a provider config limited to that key and without a budget, so no account can use another's key. Adding one checks it first (Bifrost lists models with it) and leaves nothing behind if the check fails; changing its settings asks for its secrets again, is checked with a throwaway key, then replaces the key in place; deleting one removes the key, the custom provider and the provider config. Deleting the account removes all of it and the virtual key (`packages/auth/src/gateway.ts`).
- **Model ids** everywhere (`provider_connections.models`, `default_model`, `monitors.model`) are Bifrost model strings: `wts/wts-pro`, `openai/gpt-…`, `anthropic/claude-…`, `azure/<model>`, `c-…/…`.
- **The agent** sends every request as Chat Completions to `${BIFROST_URL}/v1` with the `provider/model` string, which Bifrost translates for each provider (tools, `tool_choice`, images), with the virtual key and, for an own key, the header `x-bf-api-key-id` naming it. Base URLs are never read from the database.
- **Base URL safety.** Bifrost requests whatever base URL an owner types, so the web app only accepts `https` URLs whose host resolves to public addresses. `ALLOW_PRIVATE_NETWORK=true` lifts this for a server on your own machine; never set it in production.
- **API.** `apps/web/app/api/connections`: list (with what is left of the credit), create, update, delete, and test. No key is ever returned.

The user-facing guide is `apps/docs/content/docs/connections.mdx`.

## Object storage

Screenshots, text blocks, Change Records and browser storage state live in the
private R2 bucket, behind the object-store Worker (`packages/cloudflare`).
Nothing is public. The web app serves them through `/api/v1/objects/{key}`,
which checks that the viewer can see the Monitor and then redirects to a
signed Worker URL that is valid for 5 minutes.

**1. Run the Worker** (simulated R2, port 8787):

```bash
cd packages/cloudflare
cp .dev.vars.example .dev.vars   # set R2_API_TOKEN and R2_SIGNING_SECRET
pnpm dev                         # wrangler dev on http://localhost:8787
```

**2. Point every service at it** in `.env`, using the same two secrets:

```bash
R2_WORKER_URL=http://localhost:8787
R2_API_TOKEN=<same as .dev.vars>
R2_SIGNING_SECRET=<same as .dev.vars>
R2_ACCESS_KEY_ID=              # leave empty: the scheduler then runs in Worker-only mode
```

The browser worker always uploads through the Worker. The scheduler picks its
store with `r2.NewStoreFromEnv`: S3 credentials win when `R2_ACCESS_KEY_ID`
is set, and otherwise it runs in **Worker-only mode**, where every read and
write goes through `R2_WORKER_URL`. Use Worker-only mode locally, because
`wrangler dev`'s simulated bucket and MinIO are **different buckets**. The web
app needs only `R2_WORKER_URL` and `R2_SIGNING_SECRET`.

**Optional: MinIO for the S3 path.** Use it only to exercise the scheduler's
S3 client. Objects written there are not visible through `wrangler dev`.

```bash
docker compose -f infra/docker-compose.yml --profile storage up -d watchthatsite-minio
R2_ENDPOINT=http://localhost:5204
R2_USE_PATH_STYLE=true
R2_ACCESS_KEY_ID=$MINIO_ROOT_USER R2_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD R2_BUCKET=watchthatsite
```

See `packages/cloudflare/README.md` and `packages/cloudflare_go/README.md`
for the key layout and the signed-URL format.

## Configuration

All configuration is in the repo-root `.env`; every app's and service's `.env` is a symlink to it. `.env.example` documents each variable. The ones that tie the processes together:

| Variable | Read by | Purpose |
| --- | --- | --- |
| `ENCRYPTION_KEY` | web, browser worker | Seals each account's virtual key and Macro secrets. 32 bytes as hex (`openssl rand -hex 32`). |
| `BIFROST_URL` | web, browser worker, auth | The model gateway (default `http://localhost:5203`). |
| `BIFROST_ADMIN_USERNAME`, `BIFROST_ADMIN_PASSWORD` | Bifrost, web, auth | The gateway's admin login: virtual keys, provider keys. |
| `OPENAI_API_KEY` | Bifrost | Our key behind the platform credit. |
| `AGENT_ADDR` | browser worker | Where the agent API listens (default `127.0.0.1:5220`). |
| `AGENT_URL`, `AGENT_TOKEN` | scheduler, web, browser worker | Where the agent API is reached, and its bearer token. |
| `SCHEDULER_ADMIN_ADDR` | scheduler | Where the admin API listens (default `:5210`). |
| `SCHEDULER_ADMIN_URL`, `SCHEDULER_ADMIN_TOKEN` | web, scheduler, tests | Where the admin API is reached, and its bearer token. Without the token the API is off and Run now does not work. |
| `WEB_URL` | scheduler | Origin for links in notifications (default: `NEXT_PUBLIC_APP_URL`). |
| `R2_WORKER_URL`, `R2_API_TOKEN`, `R2_SIGNING_SECRET` | scheduler, browser worker, web | The object-store Worker (see above). |
| `ALLOW_PRIVATE_NETWORK` | web | Lets a connection's base URL be http or a private address. Local development and tests only. |
| `TEST_OPENAI_API_KEY` | tests | A real OpenAI key for suites that call a model. Optional. |

The agent API and the scheduler admin API each have one shared token and no per-user authorization. They are for the services to call each other: do not expose them publicly.

## Running the end-to-end suite

The suites in `tests/e2e` drive the whole local stack against the fixture
pages in `apps/sample-pages`, with a real model:

- `agentic.e2e.test.ts` goes through the services' own doors. One story is a
  public page: the Watch Plan, Noise that never reaches the model, a visual
  Change, a text Change, content added after planning, the webhook Reaction.
  The other is a price behind a sign-in: the Agent records a Macro, it is
  replayed with a saved session, a Change is found behind it, and a step is
  repaired after the site renames a tab.
- `ui.e2e.test.ts` does the same work as a person would, in a browser: sign
  in, create Monitors through the form, approve a recorded Macro, read the
  Change view.

They do not start services: a missing one fails the run with a single "stack
not running" message that lists what is down and how to start it. Both are
skipped without `TEST_OPENAI_API_KEY` (a funded OpenAI key; a full run costs a
few cents). Configuration comes from `tests/.env`, then the repo-root `.env`.

**1. Infra and database** (this repo is not deployed, so the data is disposable):

```bash
make docker-reset                 # optional: wipe volumes
make docker-up                    # Postgres, PostgREST, RabbitMQ, Bifrost
make migrate && OVERWRITE=true make backfill-jwks
pnpm install
```

**2. Set in `.env`** (besides the database and RabbitMQ settings; `make init`
generates the secrets):

```bash
ENCRYPTION_KEY=<openssl rand -hex 32>
AGENT_TOKEN=<any secret>
SCHEDULER_ADMIN_TOKEN=<any secret>
R2_WORKER_URL=http://localhost:8787
R2_API_TOKEN=<same as packages/cloudflare/.dev.vars>
R2_SIGNING_SECRET=<same as packages/cloudflare/.dev.vars>
R2_ACCESS_KEY_ID=                                  # empty: the scheduler uses the Worker
ALLOW_PRIVATE_NETWORK=true                         # the fixtures are on localhost
NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS=localhost,127.0.0.1
TEST_OPENAI_API_KEY=<a funded OpenAI key>
```

**3. Start each long-running process in its own terminal:**

```bash
pnpm --filter @watchthatsite/sample-pages dev    # fixture pages on :3003
pnpm --filter @watchthatsite/cloudflare dev      # object-store Worker on :8787 (needs packages/cloudflare/.dev.vars)
pnpm --filter @watchthatsite/web dev             # web app on :3000
make run-browser-worker                          # Captures, Macros and the agent API on :5220
make run-notification-service                    # delivers the webhook Reaction
make run-scheduler-service                       # admin API on :5210
```

**4. Run the suites:**

```bash
cd tests && pnpm test:e2e                          # both, one file after the other
cd tests && pnpm vitest run e2e/agentic.e2e.test.ts
cd tests && pnpm vitest run e2e/ui.e2e.test.ts
```

- The two files flip the same fixture pages, so they must not run in parallel;
  `pnpm test:e2e` runs them one at a time.
- `TEST_MODEL` picks the model the service-level suite uses (default
  `gpt-5.4-mini`, sent as `openai/gpt-5.4-mini` through the gateway); the
  browser suite uses the connection's default model.
- The model's wording varies from run to run, so the assertions check facts
  (the summary mentions the new price, every item cites evidence, the
  testimonial Section is ignored), not sentences. Each test prints what the
  model said.
- `E2E_SHOTS_DIR=<folder>` makes the browser suite save a screenshot of every
  screen. `E2E_KEEP_USER=1` keeps the test user and its Monitors for a look
  around; its email and password are printed.
- `tests/proxy/proxy.e2e.test.ts` starts its own copy of the sample pages, so
  stop the one from step 3 before running `pnpm test:proxy`.

## Project layout

```
apps/
  web/              Next.js app (auth, Monitors, Change view, Channels, model connections)
  docs/             Fumadocs site
  site/             Marketing site
  sample-pages/     Fixture pages for the E2E suite
packages/
  auth/             Better Auth config and the PostgREST client
  cloudflare/       Object-store Worker (private R2 bucket, signed URLs)
  cloudflare_go/    Go R2 clients (S3 and Worker-only)
  db/               SQL schema, Postgres clients, the secrets vault
  email/            Email templates
  image-diff/       Go port of pixelmatch, used by the visual Comparator
  types/            Shared contracts (Monitor, Macro, Change Record, service messages)
  ui/               Shared shadcn-style components
services/
  scheduler/        Go: scheduling, the diff, verdicts, Reactions, admin API
  notifications/    Go: queue consumer that delivers per Channel
  browser-worker/   TS: Macro replay, Captures, and the agent
  proxy/            Go: outbound proxy
  core/             Shared Go config and utils
tests/              Vitest suites and local sinks
infra/
  docker-compose.yml
  rabbitmq/         Exchange and queue definitions
scripts/
  migrator/         Go: applies packages/db/migrations
  seeder/           Go: seeds dev data
```

## Database

```bash
make migrate          # apply the schema, functions and policies
make psql             # open psql inside the Postgres container
```

There is one schema file, `packages/db/migrations/schema.sql`, with no dated migrations: nothing is deployed, so a schema change means wiping the database (`make docker-reset`, then `make docker-up && make migrate && OVERWRITE=true make backfill-jwks`). `functions.sql` and `rls.sql` (what the browser may read and write through PostgREST) are re-applied on every run.

## Notification channels

Configure channels per-user or per-org from the web UI: **Settings → Notifications**.

Supported channels:

| Channel  | Variants                                               |
| -------- | ------------------------------------------------------ |
| Email    | recipient list                                         |
| Slack    | incoming webhooks                                      |
| Discord  | webhook, bot token (channels + DMs), WatchThatSite bot |
| Telegram | bot token + chat IDs, WatchThatSite bot                |
| Webhook  | endpoint URLs with a signing secret; the body is the Change Record JSON |

Every Channel renders the same Change Record: a summary, the changed words with context, a crop of the first visual region when there is one, why it fired, and links to the Change view. Each Monitor's urgency decides whether a Change is sent at once or collected into an hourly or daily digest.

The scheduler caches `notification_config` in-memory; cache invalidation is wired through a Postgres `LISTEN/NOTIFY` channel (`notification_config_changed`) fired by a row trigger.
