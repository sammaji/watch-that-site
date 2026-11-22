# Browser Worker

## Overview

The browser worker is where WatchThatSite touches a real browser and a real model. It does three things:

- **Capture.** It consumes scheduled Runs from RabbitMQ, opens the Monitor's URL in Chromium, replays the Monitor's **Macro** if it has one, and publishes a **Capture**: the page's blocks, a stabilized screenshot, and load metadata.
- **Macro player.** It replays a Macro's steps with plain Playwright. No model is involved.
- **Agent.** It runs the model-driven jobs on the Monitor's model connection, through the Bifrost model gateway: **plan** (divide a page into Sections), **compare** (is this difference a Change the owner asked about?), **record** (turn a goal into a Macro) and **repair** (complete a Macro step that stopped working). The scheduler and the web app reach these through a small HTTP **agent API**.

It never decides on its own whether something changed: the scheduler diffs Captures, asks the Agent, and keeps the verdict.

External dependencies:

- RabbitMQ for job delivery and Capture publishing
- Chromium through `playwright-core`
- Postgres (through `@watchthatsite/db`) for Monitors, Macros, model connections, secrets and the `run_steps` trace
- The object-store Worker (`packages/cloudflare`) for screenshots, step screenshots, stored blocks and saved sessions
- The Bifrost model gateway, called with the official `openai` SDK
- The Ghostery block lists (downloaded once, cached on disk) for ad, tracker and cookie-banner blocking

## Core Architecture

`src/index.ts` is the composition root. On startup it launches the browser pool, checks Postgres, starts the agent API, opens the AMQP connection and starts consuming. A startup failure logs and exits non-zero.

```text
monitor_runs.scheduled ─▶ Router/Consumer ─▶ Handler ─▶ Capture ──▶ Macro runner ─▶ player
   (ScrapeJob v3)          prefetch 5, ack    validate      │             │  └─ step fails ─▶ Agent: repair
                                                            │             └─ run_steps (macro, repair)
                                                            ▼
                               monitor_runs / monitor_scrape_result  (Capture v3)

scheduler ─▶ POST /internal/plan     ─▶ Agent: plan     ─▶ run_steps (plan)
scheduler ─▶ POST /internal/compare  ─▶ Agent: compare  ─▶ run_steps (compare)
web app   ─▶ POST /internal/macros/record ─▶ Agent: record (background) ─▶ macros, run_steps (record)
web app   ─▶ POST /internal/macros/test   ─▶ player, once, in a fresh browser
```

| Area      | Files                                                                                                                                                                            | What it does                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Queue     | `router.ts`, `lib/consumer.ts`, `lib/publisher.ts`                                                                                                                               | One channel per queue, restart with backoff, `ack` after the Capture is confirmed by the broker, drain on shutdown      |
| Job       | `handler/scrape-job.ts`                                                                                                                                                          | Parses ScrapeJob v3 strictly; publishes exactly one Capture per job                                                     |
| Capture   | `lib/capture.ts`, `lib/stabilize.ts`, `lib/blocks.ts`, `lib/screenshot.ts`, `lib/validity.ts`, `lib/blocking.ts`                                                                 | Open, stabilize, replay, read blocks, shoot, check validity, upload                                                     |
| Browsers  | `lib/browser-pool.ts`                                                                                                                                                            | A fixed pool (2 Chromium × 10 contexts); every context has locale `en-US`, timezone `UTC`, scale factor 1               |
| Macro     | `macro/player.ts`, `macro/selectors.ts`, `macro/secrets.ts`, `macro/run.ts`, `macro/validate.ts`, `macro/test.ts`                                                                | The player, selector resolution and generation, secrets, the Run-level replay with repair, step validation, test replay |
| Agent     | `agent/loop.ts`, `agent/providers/*`, `agent/compare.ts`, `agent/plan.ts`, `agent/record.ts`, `agent/repair.ts`, `agent/browser.ts`, `agent/site-scope.ts`, `agent/page-data.ts` | One loop, two provider adapters, four jobs                                                                              |
| Agent API | `http/server.ts`                                                                                                                                                                 | Routes, auth, input validation, error mapping                                                                           |
| Postgres  | `store/store.ts`, `store/pg.ts`, `store/trace.ts`                                                                                                                                | Everything read from and written to the database, behind one interface                                                  |

The message and HTTP contracts live in `@watchthatsite/types` (`protocol.ts`, `macro.ts`, `watch-plan.ts`). `src/types.ts` holds only worker-internal types.

## Capture

### ScrapeJob v3 (consumed from `monitor_runs.scheduled`)

```jsonc
{
    "version": 3,
    "run_id": "uuid",
    "monitor_id": "uuid",
    "url": "https://…",
    "viewport": { "w": 1366, "h": 768 },
    "capture": {
        "screenshot": "webp" | "png",
        "full_page": true,
        "max_height": 8000,
        "extra_wait_ms": 0,
        "block_ads": true,
        "block_cookie_banners": true
    },
    "macro_id": "uuid" | null,
    "storage_state_key": "state/{monitor_id}.json" | null,
    "env_version": "…"
}
```

`parseScrapeJob` rejects the job (no Capture, dead-lettered) unless: `version` is 3; the ids are UUIDs; `url` is http(s); `viewport.w/h` are integers in 1..4096; every `capture` field is present and typed (`max_height` 1..20000, `extra_wait_ms` 0..60000); `macro_id` is present and a UUID or `null`; `storage_state_key` is present and `null` or exactly `state/{monitor_id}.json`; `env_version` is non-empty. Unknown fields are dropped.

### Capture v3 (published to exchange `monitor_runs`, routing key `monitor_scrape_result`)

The scheduler decodes Captures with unknown fields disallowed, so the worker emits exactly the fields of the `Capture` type, always all of them. A handler test compares a Capture the worker really produces with the scheduler's own fixture (`services/scheduler/internal/capture/testdata/capture-v3.json`), key for key.

```jsonc
{
    "version": 3, "run_id": "…", "monitor_id": "…",
    "status": "ok" | "invalid" | "error",
    "invalid_reason": null | "http_status" | "challenge" | "empty" | "blank_screenshot" | "cross_domain" | "macro_failed",
    "error": null | { "message": "…" },
    "blocks": [{ "id": "b0", "path": "/html[1]/body[1]/…", "tag": "p", "text": "…", "rect": [x, y, w, h] }],
    "truncated": false,
    "screenshot": { "key": "captures/{m}/{r}/shot.webp", "w": 1366, "h": 4210, "format": "webp" } | null,
    "masks": [[x, y, w, h]],            // regions that kept changing between two frames
    "meta": { "http_status": 200, "final_url": "…", "title": "…", "stable": true, "env_version": "…",
              "timings_ms": { "load": 812, "settle": 1400, "total": 3100 } },
    "macro": null | { "macro_id": "…", "status": "ok" | "repaired" | "failed", "failed_step": null | 3,
                      "repaired_macro_id": null | "…", "input_tokens": 0, "output_tokens": 0 }
}
```

- `ok`: blocks, screenshot and masks are set. `invalid`: `invalid_reason` is set, `screenshot` is `null`, `masks` is `[]`. `error`: `error.message` is set (first line of the exception), everything else empty.
- `macro_failed` also carries `error.message`, written for a person: `Step 3 (Open the Billing tab) could not be completed: no element matched`. `macro.failed_step` is the step's index in the stored Macro.
- `macro` is `null` when the job had no Macro. Its token counts are the model usage of repairs in this Run.

### What a Run does

1. **Lease a context.** With a `storage_state_key`, the Monitor's saved cookies and localStorage are restored, so a session a Macro signed in to is still there. Missing or unreadable state starts fresh.
2. **Open the URL** (`domcontentloaded`, 30 s; through `PROXY_URL` when set) with the requested block lists enabled.
3. **Stabilize**: `load`, `document.fonts.ready`, 500 ms with no request in flight (10 s cap), the Monitor's extra wait, a scroll through the page to trigger lazy loading, then CSS that freezes transitions and animations.
4. **Replay the Macro** when the job names one (below), then stabilize again. The page is not opened a second time: what is read next is the page as the Macro left it.
5. **Validity**, on the document the page now shows: `challenge` (a bot wall; checked first because those answer 403/503), `http_status` (400 or above), `cross_domain` (ended on another registrable domain). `cross_domain` is skipped when a Macro ran: it may legitimately end on another host.
6. **Blocks** (below). A page whose blocks have no text at all is `empty`.
7. **Screenshot with the two-frame check**: two frames 300 ms apart; if they differ, up to 3 retries, then `meta.stable = false` and the differing cells of a 16 px grid, merged into rectangles, go into `masks`.
8. **Blank check**: one colour over 98 % of the pixels and almost nothing painted where the text blocks are is `blank_screenshot`.
9. **Upload** the screenshot as WebP (quality 80) or PNG to `captures/{monitor}/{run}/shot.{format}`, and after an `ok` Capture save the storage state back.
10. Publish the Capture, wait for the broker's confirm, `ack`.

A Run without a Macro has 90 s; a Run with one has 7 minutes, enough for the replay and its repairs. Past the deadline the context is closed and the Run publishes an `error` Capture. Both stay well under the scheduler's 15-minute stale-Run reaper and RabbitMQ's 30-minute acknowledgement timeout.

### Blocks

`lib/blocks.ts` walks the page once and emits blocks in document order, each with an absolute XPath (`/html[1]/body[1]/main[1]/p[2]`) and its rectangle in page pixels, which are also the screenshot's pixels.

- **Text blocks.** `p`, `li`, headings, table cells, `blockquote`, `button`, `label` and the like are always blocks; any other element that is not inline-level is one when it has text of its own. Each piece of text lands in exactly one block: a block that contains other blocks keeps only its own text, and a wrapper with none is dropped. `display: none` and `aria-hidden="true"` subtrees are not read.
- **Visual blocks.** Content with a place on the page and no words is kept too, with empty text: `img`, `svg`, `canvas`, `video`, `iframe`, `object`, `embed`, and any element with a CSS background image, when visible and at least 24 px on each side and 48 × 48 px in area. They are what lets a Watch Plan root a Section on a hero image or a chart, and what makes the Section's rectangle cover the picture and not only its caption. They never change the text of the blocks around them, and they are kept inside `aria-hidden` subtrees (a decorative image is hidden from screen readers, not from the screenshot).
- Caps: 5,000 blocks or 200,000 characters, then `truncated: true`.

### Blocking

`block_ads` enables the Ghostery ads-and-tracking engine; `block_cookie_banners` the cookie and annoyances lists. Each engine is built once and cached under `BLOCKER_CACHE_DIR`. If the lists cannot be loaded the Capture goes ahead without them and the load is retried after 10 minutes.

## Macro player

A Macro is an ordered list of steps (`MacroStep` in `@watchthatsite/types`): `navigate`, `click`, `fill`, `select`, `press`, `scroll`, `wait_for`, `wait`. `macro/player.ts` runs them on a Playwright page; the same steps on the same page do the same thing.

**Finding the element.** A step lists several selectors, most stable first. The player uses the first that resolves to exactly one visible element before the step's timeout (`timeout_ms`, default 10 s; 30 s for `navigate`). Every selector is polled until the deadline, but later ones join the race one stagger apart (at most 750 ms each), so the best selector gets a head start and a dead one costs only its stagger, not the budget. A selector that matches several elements, or only a hidden one, is passed over.

**Selector strings** are Playwright selectors with two additions:

| Form                                                                             | Becomes                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `role=button[name="Sign in"]`, `text=Annual`, `css=#plan`, `xpath=//form//input` | Playwright's own engines                                             |
| `label=Email`, `label="Email"`                                                   | `getByLabel` (quoted is exact, bare is a case-insensitive substring) |
| `placeholder=Search`                                                             | `getByPlaceholder` (same quoting rule)                               |
| `data-testid=save`                                                               | `getByTestId`                                                        |

**Outcome of a step.** `ok`; `skipped` when the step is `optional` and its element (or awaited text) never showed up; `failed` otherwise, which stops the replay. An optional step still fails on any other problem, such as a missing secret. After `navigate`, `click`, `press` and `select` the player waits for the page to settle (a light version of the stabilizer). `navigate` only opens http(s) URLs.

**Secrets.** A `fill` value may contain `{{secret:name}}`. The player reads the value from `monitor_secrets` → `secrets` (the vault, purpose `macro_secret`) at the moment it types it. The value goes into the field and nowhere else: not into logs, step results, `run_steps.detail`, or error messages (which are scrubbed), and a field that shows a typed secret in clear is covered in every screenshot taken afterwards. A secret the Monitor does not have fails the step with a message that names it.

**During a Run** (`macro/run.ts`) each step writes a `run_steps` row (phase `macro`: the step's description, status, the selector that matched, duration) and a viewport screenshot at `steps/{monitor}/{run}/{seq}.webp`. A redelivered job first drops the rows its earlier attempt wrote.

## The Agent

One loop (`agent/loop.ts`) serves every job: a system prompt, tools with JSON schemas, a first message, a limit on model turns and on wall-clock time, and a terminal tool that ends the job. The model's arguments are checked against the tool's schema before anything runs; a bad call, an unknown tool or a rejected answer goes back as a tool error and the model tries again. Tool results may carry images. Every tool use writes a `run_steps` row with the tokens of the turn that asked for it, so the rows of a job add up to its usage.

### Model connections

Every model call goes through the Bifrost gateway (`BIFROST_URL`) with the account's virtual key; the gateway holds the provider keys (see "Model gateway and connections" in the root README). `PgStore.resolveConnection` picks the Monitor's `connection_id` and `model` when that connection is enabled; otherwise the owner's first enabled connection of their own, and the platform credit (`managed`) only when they have none, with its `default_model` or the first model it has enabled. Model ids are gateway model strings (`wts/wts-pro`, `openai/gpt-…`, `c-…/…`). The virtual key is decrypted from the vault (`virtual_key`, through `virtual_keys`) for the duration of the job; an account without one gets `no_connection` too. Every connection, whatever its provider, is spoken to the same way: Chat Completions at `${BIFROST_URL}/v1` with the `provider/model` string, which the gateway translates for Anthropic, Bedrock, Vertex, Gemini and the rest. Base URLs are server configuration, never read from the database. For an own key the request carries `x-bf-api-key-id` with the connection's gateway key, so an owner with two keys on one provider gets the right one; the platform credit's key is pinned by the gateway's routing rules. No usable connection is the error `no_connection`.

One adapter (`agent/providers/openai.ts`, the `openai` SDK) speaks Chat Completions with function tools and `image_url` data URLs: no `temperature` and no token cap (the gateway applies each model's default); `tool_choice: "required"` on every turn, because every job ends through a tool and a turn of prose is never an answer (dropped once, and for the rest of the job, if the provider answers that it does not support it); a tool's images follow its `tool` message in a `user` message; if the provider answers that tools need `reasoning_effort: "none"`, that is set once and kept for the job. There is no separate Anthropic adapter: through the gateway, Anthropic models lose the prompt-cache breakpoints the old adapter set: a cost, not a capability. Tool calls, `tool_choice` (as `any`) and images are translated by the gateway.

The adapter retries 429, 5xx and dropped connections up to three times with backoff, wait as long as `retry-after` says (a wait over 30 s is treated as an outage), never retry a bad key or an exhausted quota, and scrub the key out of any error text. A budget the gateway refuses (402, "Budget exceeded") is never retried either; on the platform credit it becomes "Your WatchThatSite credit is used up. Add your own model connection to keep checking pages.", which reaches the Run's error and the Change Record's `agent.error`. Nothing is read from `ANTHROPIC_*` or `OPENAI_*` environment variables.

### Plan (`POST /internal/plan`)

The scheduler asks for a Watch Plan when a Monitor gets its Baseline, when the Instructions change, and when Sections stop matching the page.

- **What the model sees:** the Instructions; the page's **block outline**, one line per block with an index, a shortened path, the tag, the first 80 characters of text (or what kind of picture it is) and the rectangle; the screenshot, downscaled and cut into tiles when the page is tall; and the previous plan when there is one, with the request to keep Section ids and, when the owner edited it last, each Section's `how`. Long runs of sibling elements (list items, table rows, cards) are shortened to the first few and the last, and each gap says which blocks it stands for.
- **Tools:** `view_region` (part of the screenshot at full resolution), `read_block` (a block's full text and its neighbours), `list_blocks` (everything under a path, including what the outline left out), and the terminal `submit_plan`.
- **From indexes to paths.** The model names a Section by block index ranges, or by a path copied from the outline; it never writes an XPath. `rootsFor` turns the indexes into paths: from each block it climbs to the largest element that holds nothing but the Section's blocks. So a Section takes the whole card or figure its blocks fill, and never an ancestor that would swallow a neighbouring Section.
- **Guards.** A plan is sent back with a specific message when a Section matches no block, a `how` is not one of `text`, `visual`, `both`, `ignore`, there are more than 24 Sections, two Sections cover the same element, or a name, reason or summary is missing. A job that never produces a valid plan fails with `provider_error`; it never returns an empty plan.

### Compare (`POST /internal/compare`)

The scheduler has already diffed two Captures; the Agent decides.

- **First message:** the Monitor's name, URL and Instructions; the owner's recent feedback as examples; then the evidence grouped by Section, each with how the Watch Plan says it is watched and why. Text ops are rendered compactly with their index (added, removed, moved, or changed with word-level `[-old-] {+new+}` and a line of context); regions with their index and box. The diff is capped at about 14,000 characters; what does not fit is counted and paged with `read_diff`.
- **Images:** for a Section watched as `visual` or `both` that has regions, the whole Section before and after; then every region before and after, padded with 32 px of context, at full resolution unless a side exceeds 1,568 px. At most 16 images go into the first message, largest regions first, and the message says which were left out. A Section is compared crop against crop, so the "before" crop of a region follows the Section to where it was on the previous page.
- **Tools:** `read_diff`, `read_page` (text of either page around an op, a block or some words, from the Capture's `blocks.json.gz`), `view_region`, `view_screenshot`, and the terminal `report`.
- **Evidence guard.** Every item in `report` must cite at least one valid op or region index; an answer that is `relevant` must have items. An invalid report is rejected with what is wrong, and the model tries again.
- **Writing.** The prompt asks for one specific sentence for the owner ("The Enterprise plan went from $99 to $129 a month"), short item titles, `before`/`after` that quote the page, visual changes described the way a person would, pixel differences that are not real changes (anti-aliasing, a sub-pixel shift, a compression artefact, an animation frame) put in `ignored`, and `ignored` reasons in the owner's terms.

### Record (`POST /internal/macros/record`)

The route inserts the next Macro version as `recording` (source `agent`) and returns its id at once; the work runs in the background, at most 3 recordings at a time.

1. A fresh context opens the Monitor's URL and is stabilized like a Capture.
2. The Agent works towards the goal with browser tools: `snapshot` (the page's interactive and landmark elements, each with a short ref, its role, name, placeholder, value and whether it is a password field, plus a viewport screenshot), `click`, `fill`, `select`, `press`, `scroll`, `wait_for`, `navigate`, and the terminal `done` and `fail`. Every action returns the new element list.
3. Each action that succeeds becomes a step, with the `intent` the model gave and **ranked selectors generated from the element itself**: role and accessible name (as Playwright computes them), label, placeholder, test id, visible text, `#id` when the id looks stable, `tag[name=…]` for form fields, and the absolute XPath last. Only selectors that resolve to exactly that one element are kept. The model never writes a selector.
4. Sign-in fields and buttons, anything typed from a secret, and cookie-banner clicks become `optional` with a 3 s timeout: they are absent when a saved session is still valid.
5. The model is told the names of the Monitor's secrets and types them as `{{secret:name}}`. A password is never accepted as literal text. If the goal needs a credential with no secret, the Agent fails with a reason that names what is missing.
6. On `done`, the steps are replayed once in another fresh context, with no model. Pass: `draft`, for the owner to approve. Fail: `failed`, with a note saying which step did not replay. Either way the steps are saved.

Limits: 30 actions, 60 model turns, 5 minutes. `run_steps` rows have phase `record`, `macro_id` set and `run_id` null, with a screenshot per action, so the web app can show progress as it happens. Recordings in flight at shutdown are marked `failed`, and at startup any row still `recording` after 15 minutes is too.

### Repair (inside a Run)

When a step that is not optional fails, the Agent gets the browser as the replay left it, the Macro's goal, the list of steps with the failed one marked, the selectors that no longer match, and a snapshot. It has the same browser tools and **one action**: the one the step was for. That action's selectors replace the step's, the step keeps the owner's wording, and replay continues.

- At most 3 repairs per Run, 8 model turns and 75 s each.
- If replay then completes, a new Macro version is inserted in one transaction (`source: "repair"`, `status: "active"`, a note such as `Step 3 'Open the Billing tab': the button was renamed`) and the old active version is archived. The Capture reports `macro.status: "repaired"` with `repaired_macro_id` and the tokens used. If the owner replaced the Macro while the Run was going, nothing is saved.
- No usable connection, a failed model call, or a step the Agent cannot complete is `macro_failed`, with the reason in the message.

## Agent API

A small HTTP server on `AGENT_ADDR` (default `127.0.0.1:5220`), started with the consumers and shut down with them.

| Route                          | Caller    | Does                                                                                                                   |
| ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /internal/health`         | anyone    | `{ "ok": true, "routes": true \| false }`                                                                              |
| `POST /internal/plan`          | scheduler | `PlanRequest` → `PlanResponse`                                                                                         |
| `POST /internal/compare`       | scheduler | `CompareRequest` → `CompareResponse`                                                                                   |
| `POST /internal/macros/record` | web app   | `RecordMacroRequest` → `{ macro_id }`, at once                                                                         |
| `POST /internal/macros/test`   | web app   | `TestMacroRequest` → `TestMacroResponse`, after replaying the steps once in a fresh context with the Monitor's secrets |

Everything but health needs `Authorization: Bearer $AGENT_TOKEN`, compared in constant time. Without `AGENT_TOKEN` only health is served and the other routes answer 503.

Inputs are validated before any work: ids are UUIDs, object keys belong to the Monitor of the request, steps have the fields their type needs (at most 40 steps, `navigate` only to http(s), bounded timeouts and waits), bodies are at most 20 MB.

Errors are `{ "error": { "code", "message" } }`:

| Code             | Status                                                   | When                                                          |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `bad_request`    | 400 (413 for a body too large, 405 for the wrong method) | The input does not hold up                                    |
| `unauthorized`   | 401                                                      | Missing or wrong token                                        |
| `not_found`      | 404                                                      | No such route, Monitor, or stored blocks                      |
| `no_connection`  | 409                                                      | The Monitor has no usable model connection                    |
| `provider_error` | 502                                                      | The model call failed, or the model never gave a valid answer |
| `internal_error` | 500 (503 when `AGENT_TOKEN` is unset)                    | Anything else; the message says nothing about the inside      |

`TestMacroResponse.steps` has one entry per step that was reached; steps after a failure are not listed. Its screenshot is filed as `steps/{monitor}/{a fresh uuid}/{index of the last step that ran}.webp`.

## Security rules

- **Page content is data.** A watched page is written by someone else and can try to instruct the Agent. Page text and screenshots never go into the system prompt. Wherever page text appears it is wrapped in a `<page-data-…>` tag whose name carries a random suffix made for that one job, so text on the page cannot close a tag it cannot guess; every system prompt says that what is inside those tags, and what is in an image, is material to examine and never an instruction.
- **Secrets never reach the model.** The model sees secret names and types placeholders. Values are read at the moment they are typed, and everything on its way to a model, a log or the database passes a scrubber that puts the placeholder back. A password field's value is never read from the page; a plain field holding a typed secret is covered in screenshots.
- **The site-scope rule.** While recording or repairing, the Agent may open, or click a link to, only the Monitor's own site (the same registrable domain as its URL, by `tldts`), or a host the site itself sent the browser to during the session: an HTTP redirect, or the page navigating after a click or form submit on the site, which is how single sign-on reaches an identity provider. A URL the Agent names, an off-site link it clicks, or a form that submits off-site is refused, and a URL it names that redirects off the site is undone: the browser steps back. New tabs are closed. The player is not bound by this rule: it replays steps the owner approved or wrote.
- **Model keys** are decrypted per job, passed only to the provider's SDK, and scrubbed from error text. The scheduler never sees one.
- **Object keys** in a request must lie under `captures/{monitor_id}/`, so a caller cannot point the Agent at another Monitor's Captures.

## Failure Handling

- A Capture that cannot be taken (navigation error, timeout, upload failure, storage not configured) is published as `status: "error"` and the job is acked.
- If publishing fails, the consumer tries once more to publish an error Capture; if that fails too, or the job never parsed, the message is `nack`ed without requeue and RabbitMQ's dead-letter policy takes over.
- A `run_steps` row that cannot be written is logged and dropped. The trace is for people to read; it never fails a Capture or a job.
- Consumer channel deaths are restarted with backoff; an unexpected AMQP connection close exits the process with code 1.
- On `SIGINT`/`SIGTERM`: cancel consumers and wait for in-flight handlers, stop the agent API, stop recordings, then close the publisher channel, the pool, the AMQP connection and the Postgres client. A 30 s watchdog force-exits; a Run still replaying a long Macro at that point is redelivered.

## Operational Notes

- The service runs with `tsx` (`pnpm start`, `pnpm dev`): the workspace packages it imports ship TypeScript source. tsx compiles with esbuild's `keepNames`, which wraps nested functions in a `__name(...)` helper; a function handed to `page.evaluate` is serialized and runs in the page, where that helper does not exist. `BrowserPool` therefore installs the helper in every context it opens. The unit tests run under Vitest, which does not add the wrapper, so only a test that asserts the helper is present (in `macro/player.test.ts`) and the end-to-end suite guard this.
- Required environment variables: `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `RABBITMQ_HOST`, `RABBITMQ_PORT`; `DATABASE_URL` or `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`.
- Needed for the Agent and for Macros with secrets:
    - `ENCRYPTION_KEY`: the vault key (32 bytes as 64 hex characters). Without it the virtual keys and secrets cannot be read.
    - `BIFROST_URL`: the model gateway every model call goes through (e.g. `http://localhost:5203`). Without it every job is `no_connection`.
    - `AGENT_TOKEN`: the bearer token of the agent API. Without it only `/internal/health` is served.
    - `AGENT_ADDR`: where the agent API listens, default `127.0.0.1:5220`.
    - `R2_WORKER_URL`, `R2_API_TOKEN`: the object-store Worker. Without them the worker boots, but every Capture is an `error`, and the Agent has no screenshots or blocks to look at.
- Optional: `LOG_LEVEL` (pino, default `info`), `PLAYWRIGHT_EXECUTABLE_PATH`, `PROXY_URL` (routes the first page load through the preview proxy), `BLOCKER_CACHE_DIR` (default `$TMPDIR/wts-adblocker`).
- Limits and tuning live in `src/config/constants.ts`:

| What               | Value                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| Capture deadline   | 90 s without a Macro, 7 min with one                                                  |
| Step timeout       | 10 s (30 s for `navigate`); 3 s on recorded optional steps; `wait` at most 30 s       |
| Repairs            | 3 per Run; 1 action, 8 turns, 75 s each                                               |
| Compare, plan      | 12 turns, 3 min                                                                       |
| Record             | 30 actions, 60 turns, 5 min; 3 at once                                                |
| Images for a model | longest side 1,568 px; small crops as PNG, large as JPEG                              |
| Pool               | 2 Chromium × 10 contexts, shared by Captures (5 at once), recordings and test replays |

- Tests: `pnpm test` runs vitest against real headless Chromium and local fixture pages; nothing hits the internet. Model calls go to a scripted fake provider (`src/testing/fake-provider.ts`) that speaks both wire formats and keeps every request for inspection. The suites that exercise Postgres (`store/pg.test.ts`, recording and repair end to end, the compare trace) read `.env`, create their own user, virtual key, Monitor and connection, and remove them, with the fake provider standing in for the gateway; without `POSTGRES_*` and `ENCRYPTION_KEY` they skip. `REAL_MODEL=1 pnpm test src/agent/real-model.test.ts` runs one test per job against OpenAI with `TEST_OPENAI_API_KEY` (`REAL_MODEL_NAME` picks the model). `pnpm typecheck` needs `@watchthatsite/cloudflare` built.

## Current Limitations

- **A repair is one action.** A page that now needs two (a new dialog to dismiss before the button) fails the Run with `macro_failed`; the owner records the Macro again or adds a step.
- **One page, top frame only.** The Agent's snapshot does not look inside iframes, and a click that opens a new tab has the tab closed.
- **A position alone is not trusted.** The recorder adds an absolute XPath as a step's last selector. When a step also has selectors that name its element (role, label, text, id) and none of them match, the player does not act on whatever now sits at that position: it could be the same control renamed, or a different one, and pressing the wrong button in a signed-in session is worse than a failed Run. The step fails with a message that says what is there now ("where it used to be there is now a button reading \"Plans & invoices\""), and the Agent looks at the page and repairs the step. A step whose only selectors are positional, written that way by hand, is taken at its word.
- **Sign-in and cookie-banner detection is heuristic** (a password field in the form, `autocomplete`, the page's path, ids and classes that mention cookies or consent). A step it misses is not marked optional and fails on a signed-in Run until someone marks it.
- **`PROXY_URL` covers the first load only.** A `navigate` step opens its URL directly.
- **No in-process AMQP reconnect.** An unexpected connection close exits the process.
- **A queue can be abandoned at runtime** after repeated consumer failures (`fatal` log); restart to recover.
- **Unbounded pool wait.** `acquire()` has no timeout; bounded in practice by 5 Captures and 3 recordings against 20 contexts, but many test replays at once can queue.
- **Challenge detection is signature-based.** A bot wall that matches none of the signatures passes as content.
