# WatchThatSite

Watch any web page and get told when something you care about changes. You give a **Monitor** a URL and plain-words instructions ("tell me when there are new product manager roles"). On every **Run** a real browser captures the page, the scheduler diffs it against the last Capture, and, only when something differs, an AI agent decides whether the difference is a **Change** you asked about. Changes are sent to Email, Slack, Discord, Telegram or a webhook.

- Production: <https://app.wts.sammaji.com> (landing page <https://wts.sammaji.com>, docs <https://docs.wts.sammaji.com>).

## How it works

```
 web app (Next.js) ──PostgREST (RLS)──▶ Postgres ◀── scheduler (Go) ──RabbitMQ──▶ browser worker (TS + Playwright)
        │                                              │      ▲                         │  replays Pre-scraping steps,
        │ Run now / record Pre-scraping                │      └──── Capture ────────────┘  takes the Capture
        └──────────────────────────────────────────────┤
                                                        │ differs? POST /internal/compare
                                                        ▼
                                          agent API (in the browser worker) ──▶ Bifrost gateway ──▶ OpenAI / own keys
                                                        │ verdict + Change Record
                                                        ▼
                                          notifications (Go) ──▶ Email · Slack · Discord · Telegram · Webhook
```

1. The **scheduler** finds due Monitors and publishes a scrape job to RabbitMQ.
2. The **browser worker** opens a fresh browser, replays the Monitor's **Pre-scraping** steps (for example, signing in) and captures a screenshot plus text blocks. These go to the **object store** (a Cloudflare Worker over R2, run locally with `wrangler dev`).
3. The scheduler diffs the Capture against the Baseline. If they are identical the Run ends with no model call.
4. If they differ, the **agent** reads the instructions and the evidence and calls the model through **Bifrost**, using the account's virtual key. It answers whether this is a Change, with a summary, the changed items and what it ignored.
5. The scheduler records the verdict and the **notifications** service delivers it.

Each account starts with $10 of WatchThatSite credit (our OpenAI key behind Bifrost) and can add its own provider keys under **BYOK**.

## Prerequisites

| Tool                         | Version                                                   | Check                    |
| ---------------------------- | --------------------------------------------------------- | ------------------------ |
| Node.js                      | 22 or newer (developed on 24)                             | `node -v`                |
| pnpm                         | 10.33 (`corepack enable` picks it up from `package.json`) | `pnpm -v`                |
| Go                           | 1.26 or newer                                             | `go version`             |
| Docker                       | with Compose v2 (Docker Desktop or OrbStack)              | `docker compose version` |
| make, openssl, python3, curl | any recent version                                        |                          |

You also need an **OpenAI API key** for the platform credit; the agent can't decide anything without a model. A **Resend** key is optional: without one, sign-up and password-reset links are printed in the `make dev` output instead of being emailed.

## Setup (once)

```bash
git clone <this repo> watchthatsite && cd watchthatsite

make init
```

`make init` does the following:

- creates `.env` from `.env.example`, generating every local secret: auth, database, RabbitMQ, Bifrost, encryption, the agent and admin tokens, the proxy key and the object-store keys;
- symlinks `.env` into every app and service, and writes `packages/cloudflare/.dev.vars` to match it;
- sets up the Go workspace and installs JS dependencies;
- starts Postgres, PostgREST, RabbitMQ and Bifrost in Docker;
- applies the database schema and gives PostgREST the web app's signing keys.

Then set the one value it cannot generate, in `.env`:

```bash
OPENAI_API_KEY=sk-...        # behind the $10 platform credit
```

…and restart the gateway so it picks the key up, and install the browser the worker drives:

```bash
make docker-up
pnpm --filter browser-worker exec playwright-core install chromium
```

### Environment variables

Everything lives in the repo-root `.env`; every app's `.env` is a symlink to it. `.env.example` documents each variable. You only ever touch the first block.

| Variable                                                                                                                                                                                                                              | Needed?    | What                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                                                                                                                                                                                      | **yes**    | Our key behind the platform credit (Bifrost's `wts` provider).                                                         |
| `RESEND_API_KEY`, `SMTP_MAIL`                                                                                                                                                                                                         | optional   | Send sign-up and reset emails, and the Email notification channel. Without them, auth links are logged to the console. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                                                                                                                                            | optional   | "Sign in with Google". The redirect URI is `http://localhost:3000/api/auth/callback/google`.                           |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`                                                                                                                                               | optional   | Discord sign-in, and the Telegram bot channel.                                                                         |
| `TEST_OPENAI_API_KEY`                                                                                                                                                                                                                 | optional   | A funded key for the end-to-end suites.                                                                                |
| `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `RABBITMQ_PASSWORD`, `BIFROST_ADMIN_PASSWORD`, `BIFROST_POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `AGENT_TOKEN`, `SCHEDULER_ADMIN_TOKEN`, `PROXY_API_KEY`, `R2_API_TOKEN`, `R2_SIGNING_SECRET` | generated  | Filled by `make init`. Never change `ENCRYPTION_KEY` once data exists.                                                 |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_DOC_URL`, `NEXT_PUBLIC_SAMPLE_PAGES_URL`, `NEXT_PUBLIC_POSTGREST_URL`, `BIFROST_URL`, `AGENT_URL`, `SCHEDULER_ADMIN_URL`, `R2_WORKER_URL`, `NEXT_PUBLIC_PROXY_URL`        | defaults   | Local addresses; the defaults work as is.                                                                              |
| `ALLOW_PRIVATE_NETWORK`                                                                                                                                                                                                               | local only | `true` lets a BYOK base URL point at localhost. Never in production.                                                   |

## Start everything

Infra (Docker) stays up after `make init`; `make docker-up` starts it again after a reboot. Then run each line in its own terminal:

```bash
make dev                         # web, site, docs, sample pages, object store, browser worker + agent API
make run-scheduler-service       # scheduler (admin API :5210): due Monitors, diffs, verdicts
make run-notification-service    # delivers Changes to the channels
make run-proxy-service           # proxy (:5202): the live page preview in the Monitor form
```

| URL                          | What                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| <http://localhost:3000>      | **The app**                                                                                |
| <http://localhost:3001>      | Landing page                                                                               |
| <http://localhost:3002/docs> | Docs                                                                                       |
| <http://localhost:3003>      | Sample pages to monitor                                                                    |
| <http://localhost:5203>      | Bifrost dashboard (login: `BIFROST_ADMIN_USERNAME` / `BIFROST_ADMIN_PASSWORD` from `.env`) |
| <http://localhost:15672>     | RabbitMQ management (`RABBITMQ_USER` / `RABBITMQ_PASSWORD`)                                |

Postgres is on :5200 (`make psql`), PostgREST on :5201, the object store on :8787 and the agent API on :5220.

## Test logins

| Where                                                   | Login                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app, local                                          | Run `make demo-user` once `make dev` is up. It creates a verified account: **`demo@watchthatsite.local` / `watchthatsite-demo`**. Or sign up normally and open the verification link printed in the `make dev` output. |
| The app, production                                     | Sign up at <https://app.wts.sammaji.com/signup> (a real email is verified), or use Google.                                                                                                                             |
| Sample sign-in page (`/test/account`), for Pre-scraping | **Any email** with password **`northwind-demo`**, e.g. `owner@northwind.test`.                                                                                                                                         |

`DEMO_EMAIL=… DEMO_PASSWORD=… make demo-user` creates other accounts.

## Sample pages to monitor

`apps/sample-pages` (<http://localhost:3003>, production <https://samplepages.wts.sammaji.com>) serves pages that change on cue, so you don't wait for a real site:

| Page                         | What changes                                                                                                                       | How to change it                                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/test/careers`              | A careers board with a client-side **Department** select. A new product manager role is posted every 30 seconds (the oldest goes). | Wait 30 s, or `?refresh_interval=<ms>` for another pace.                                                                                                                                                                                              |
| `/test/account`              | A billing page **behind a sign-in** (Overview, Billing tab, Monthly/Annual switch).                                                | `curl -X POST localhost:3003/test/api/diff-state -H 'content-type: application/json' -d '{"scenario":"account","variant":"v2"}'` raises the annual Team price; `"renamed"` also renames the Billing tab (Pre-scraping repairs itself). `"v1"` resets. |
| `/test/diff/storefront`      | A pricing page with plans, a hero image and a testimonial that rotates on every load (Noise to ignore).                            | Same endpoint, `{"scenario":"storefront","variant":"v2"}` raises the Team price ($99 → $129); `"v1"` resets.                                                                                                                                          |
| `/test/diff/storefront/live` | Prices change by themselves every 30 s.                                                                                            | Nothing to do.                                                                                                                                                                                                                                        |

## Journeys to try end to end

Sign in at <http://localhost:3000/login>. You land on **Home**, where a yellow **Setup checklist** tracks the next three journeys.

**1. Configure notifications.**

- **Notifications** → **Email** → **Connect**. Add an address and **Save**; the channel is enabled straight away.
- Without Resend, use **Webhook** instead, pointing at <https://webhook.site> or any URL you control.
- The checklist ticks "Configure a notification provider".

**2. Create a Monitor with "Try an example".**

- **Monitors** → **New monitor** → **Try an example** (under the URL field).
- This fills in `…/test/careers` and "Let me know when there are new product manager roles.", and the page opens in the live preview beside the form.
- Optionally press **Select an element** and click part of the page to mention it in the instructions.
- **Save**. The first Run captures the Baseline, and the **Monitored elements** tab shows how the agent divided the page into parts and which it watches or ignores.

**3. Find a Change.**

- Wait 30 seconds and press **Run now**.
- The Run's trace shows each step. The **Changes** tab lists "new product manager role…".
- Open the Change to see the summary, the changed text and the before/after screenshots side by side.
- The notification arrives on the channel from journey 1.
- The **Timeline** tab shows quiet Runs ("No difference", greyed) and Runs with a Change.

**4. Ignore Noise.**

- Monitor `http://localhost:3003/test/diff/storefront` with "Tell me when a plan's price changes."
- Run it twice: the rotating testimonial differs, but no Change is reported.
- Flip `storefront` to `v2` (see the table above) and **Run now**: "Team $99 → $129" is reported.

**5. Pre-scraping: a page behind a login.**

- New monitor on `http://localhost:3003/test/account`, with instructions "Tell me when the annual Team price changes."
- Turn on **Before each check** and write: "Sign in, open the Billing tab, and switch the billing period to Annual."
- Add secrets `email` = `owner@northwind.test` and `password` = `northwind-demo`.
- Press **Run**. The agent does it live in a real browser, step by step (Agent tab), then records the steps.
- **Save**. The **Pre-scraping** tab shows the recorded steps, which replay without a model before every check.
- Flip `account` to `v2` and **Run now** for a Change behind the login.
- Flip to `renamed` and run again: the step that clicked "Billing" fails, is repaired by the agent, and the trace marks it repaired.

**6. Bring your own keys.**

- **BYOK** → **Add key** → OpenAI (or Anthropic, DeepSeek, Azure, and others). Name it, paste a key, **Add connection**.
- The key is checked and its models are listed. The key goes only to the gateway; the app keeps its last four characters.
- Pick the connection and model per Monitor in its form. The checklist's optional item ticks.

**7. Usage.**

- **Usage** shows the credit left, spend split between the credit and your keys, model calls, and tokens, over 24 hours, 7 days or 30 days.

**8. Day to day.**

- **Pause** or **Resume** a Monitor, **Edit** its instructions, interval or model, and view all **Monitor runs**.
- **Your account** → delete the account; this also removes everything in the gateway.

## Tests

```bash
for m in scheduler notifications proxy core; do (cd services/$m && go test ./...); done   # Go
pnpm --filter browser-worker test               # browser worker unit tests
cd tests && pnpm test:e2e                       # full-stack suites; need the stack running and TEST_OPENAI_API_KEY
```

The end-to-end suites in `tests/e2e` drive the whole running stack against the sample pages, with a real model:

- `agentic.e2e.test.ts` goes through the services directly. One story is a public page: the watch plan, Noise that never reaches the model, a visual Change, a text Change, content added after planning, and the webhook notification. The other is a price behind a sign-in: the agent records Pre-scraping steps, they replay, a Change is found behind the login, and a step is repaired after the site renames a tab.
- `ui.e2e.test.ts` does the same work in a browser, as a person would.

Before running them:

- Start everything as in "Start everything" above.
- Set in `.env`:

    ```bash
    TEST_OPENAI_API_KEY=sk-...                         # a funded key; a full run costs a few cents
    ALLOW_PRIVATE_NETWORK=true                         # the sample pages are on localhost
    NOTIFY_ALLOW_INSECURE_WEBHOOK_HOSTS=localhost,127.0.0.1
    ```

Notes:

- The suites don't start services. If one is missing, the run fails with a single "stack not running" message listing what is down.
- Both suites flip the same sample pages, so `pnpm test:e2e` runs them one at a time.
- `E2E_KEEP_USER=1` keeps the test account and prints its login. `E2E_SHOTS_DIR=<folder>` saves a screenshot of every screen.
- `cd tests && pnpm test:proxy` starts its own copy of the sample pages, so stop the one in `make dev` first.

## Model gateway and your own keys

Every model call goes through **Bifrost** (Docker, :5203, configured by `infra/bifrost.config.json`). The agent is the only code that calls a model.

- **One virtual key per account.** The web app creates it the first time the account opens the app. It is sealed in the database vault with `ENCRYPTION_KEY`, and the scheduler never sees it.
- **Platform credit.** Bifrost's custom `wts` provider uses `OPENAI_API_KEY`. The models `wts/wts-pro` and `wts/wts-mini` route to OpenAI models, with a $10 budget on each virtual key. When it is spent, the agent reports "Your WatchThatSite credit is used up".
- **BYOK.** A key the user adds is checked against the provider, stored only in Bifrost and attached to that account's virtual key. The app keeps only its last four characters and non-secret settings.
    - Supported: OpenAI, Anthropic, Azure OpenAI, Bedrock, Vertex AI, Gemini, Mistral, Groq, Cohere, Cerebras, Fireworks, xAI, OpenRouter, DeepSeek, and custom OpenAI- or Anthropic-compatible endpoints.
    - A custom endpoint must be public `https` unless `ALLOW_PRIVATE_NETWORK=true`.

## Database

- `make migrate` applies `packages/db/migrations/` (one `schema.sql`, plus functions and row-level-security policies that are re-applied every time).
- There are no dated migrations, so a schema change means starting the database from scratch (see Troubleshooting).
- `make psql` opens a shell.

## Repository layout

```
apps/web            Next.js app: auth, Monitors, Runs and traces, Changes, notifications, BYOK, usage
apps/site           Landing page          apps/docs   Docs (Fumadocs)
apps/sample-pages   Pages to monitor (careers, sign-in, storefront, test fixtures)
services/scheduler  Go: scheduling, diff, verdicts, Change Records, admin API
services/browser-worker  TS: Playwright captures, Pre-scraping record/replay/repair, the agent API
services/notifications   Go: delivery per channel    services/proxy   Go: the preview proxy
packages/           auth, db (schema, RLS, vault), email, types, ui, cloudflare (object store), image-diff
infra/              docker-compose for local infra, Bifrost config, production Dockerfile
scripts/            migrator, seeder, env setup, demo user
```

## Troubleshooting

- **Run now does nothing, or a Run stays "Running".** Check that the scheduler, the browser worker (in `make dev`) and RabbitMQ are up.
- **The preview in the Monitor form is blank.** Start `make run-proxy-service`.
- **"Your WatchThatSite credit is used up" or model errors.** Set `OPENAI_API_KEY`, run `make docker-up` again, or add your own key under BYOK.
- **Screenshots missing.** The object store must be running (part of `make dev`, port 8787), with `.dev.vars` matching `.env`.
- **Start the database from scratch:** `make docker-reset && make docker-up && make migrate && OVERWRITE=true make backfill-jwks`.
