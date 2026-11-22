# Scheduler

The Go service that runs every Monitor. It publishes due Runs to the browser worker once a minute, and evaluates each Capture the browser worker sends back: it compares the Capture with the Monitor's baseline (text and screenshot), and when they differ it asks the **agent** whether the difference is a Change the owner asked about. It records the verdict and the Change Record, and fires Reactions: instant notifications, digest items, or nothing when the Monitor is snoozed. It also keeps each Monitor's Watch Plan up to date, runs the hourly and daily digests and the daily retention job, and serves an internal admin HTTP API used by the web app and the E2E suite.

There are no Scopes, Triggers or Rules: a Monitor is a URL, instructions in plain words, an interval and a model. What counts as a Change is the agent's call. The scheduler never sees a model key; the agent runs inside the browser worker, and the scheduler calls its HTTP API.

The contracts are in `packages/types/src` (`protocol.ts`, `change-record.ts`, `watch-plan.ts`, `monitor-config.ts`) and `packages/db/migrations/schema.sql`.

---

## Core Architecture

`main.go` is the composition root. It loads the Postgres and RabbitMQ settings, opens the pgx pool, builds the object store (`r2.NewStoreFromEnv`, required), one RabbitMQ publisher connection, the notification config cache, the notifier, the agent API client and the pipeline. It then starts four runtime components that share the pool and the pipeline:

```text
                        +---------------------------------------------+
                        |                  main.go                    |
                        |  pgx pool | object store | AMQP publisher   |
                        +---------------------------------------------+
                            |                |                 |
          +-----------------+                |                 +------------------+
          v                                  v                                    v
+---------------------+        +---------------------------+        +----------------------+
| Dispatcher          |        | Artifact consumer         |        | Admin HTTP API       |
| minute tick         |        | monitor_runs.scraped      |        | :5210, bearer token  |
| SKIP LOCKED tx      |        | (own AMQP connection)     |        | Run now, run status, |
| + digests at :00    |        | N workers                 |        | baseline, plan again,|
| + retention 03:00   |        +-------------+-------------+        | compare, digests,    |
+----------+----------+                      |                      | retention            |
           |                                 v                      +----------+-----------+
           |                  +-----------------------------+                  |
           |                  | Pipeline (per-Monitor       | <----------------+
           |                  | advisory lock)              |
           |                  | validate > plan > compare > |       +----------------------+
           |                  | ask the agent > decide >    | <---> | Agent API (browser   |
           |                  | record                      |  HTTP | worker, :5220)       |
           |                  +------+---------------+------+       | /internal/compare    |
           |                         |               |              | /internal/plan       |
           v                         v               v              +----------------------+
   monitor_runs.scheduled     Postgres + object   Notifier --> notifications exchange
   (ScrapeJob v3)             storage (R2/Worker)  (config cache, LISTEN/NOTIFY)
```

| Component | Package | Responsibility |
|---|---|---|
| Dispatcher | `internal/monitor_due_jobs` | Minute-aligned tick. Inserts `processing` Runs for due Monitors, promotes due confirm Runs, publishes ScrapeJob v3, and calls the periodic jobs (digests, retention, the stale-Run reaper) on every tick. |
| Artifact consumer | `internal/artifact_worker` | Consumes Capture v3 from `monitor_runs.scraped`, decodes it strictly, hands it to the pipeline, and settles the delivery (accept, discard or requeue). |
| Pipeline | `internal/pipeline` | Evaluates one Capture inside the Monitor's advisory lock and dispatches Reactions after commit. Also implements the admin operations: Compare, AcceptBaseline, Replan, RunDigests. |
| Admin API | `internal/admin` | Internal HTTP API (see [Admin API](#admin-api)). Only started when `SCHEDULER_ADMIN_TOKEN` is set. |
| Notifier | `internal/notify`, `internal/cache` | Resolves the owner's `notification_config` rows (cached per user, invalidated by the `notification_config_changed` NOTIFY) and publishes one envelope per target to the `notifications` exchange. |

Supporting packages:

| Package | What it holds |
|---|---|
| `internal/monitor` | A Monitor as the pipeline reads it (`Config`), the capture version hash, and the Watch Plan (`WatchPlan`, `SectionFor`, `HowFor`, the plan guard and the staleness check). |
| `internal/capture` | Capture v3 types, strict decoding and validation, fingerprints (`text_hash`, SimHash, dHash). |
| `internal/diff/normalize` | Text canonicalization and volatile-token masking (relative times, clocks, today's date, counters, nonces, copyright years). Every class is always on. |
| `internal/diff/text` | Text Comparator: block alignment, word diff, moves, magnitudes. |
| `internal/diff/visual` | Visual Comparator: masks, row alignment, pixel diff on aligned bands, regions linked to blocks; Section crop against Section crop under a Watch Plan. |
| `internal/agentclient` | HTTP client of the agent API: `Compare` and `Plan`. |
| `internal/decide` | The verdict. A small pure function over the evidence, the pending state, the Monitor's confirm setting and the agent's answer. |
| `internal/changerecord` | Builds Change Record version 2 and guards the agent's items against the evidence. |
| `internal/render` | Renders a Change Record into email HTML and text, Slack, Discord, Telegram, the webhook body, digests and the "keeps failing" alert. |
| `internal/objects` | Object key layout, gzip JSON helpers, an LRU for Capture blocks, an in-memory store for tests. |
| `internal/retention` | Deletes expired evidence. |
| `internal/db` | `Store` (pool-level queries) and `Tx` (reads and writes inside a Monitor's lock) contracts and their pgx implementation; `BuildScrapeJob`. |
| `internal/broker` | RabbitMQ publisher with retry and reconnect, and the consumer loop. |

Data moves like this: the job names the Monitor's URL, capture settings and active Macro; the Capture comes back inline in the AMQP message with its blocks, but the screenshot travels by object key only. The pipeline writes the blocks to object storage (where the agent reads them too), the verdict to Postgres (`captures`, `changes`, `monitor_runs`, `monitor_state`, `digest_items`, `monitors.watch_plan`), and the Change Record plus any diff image and crop to object storage. The agent, in the browser worker, writes its own trace to `run_steps`.

---

## End-to-End Workflow

### Scheduling (every minute)

1. The tick loop waits for the next full minute, then fires once a minute. A tick runs in its own goroutine, bounded by `SCHEDULER_MAX_CONCURRENT_TICKS` (default 2). When all slots are busy the tick is skipped with a warning.
2. The tick starts the periodic jobs in the background: the hourly digest at minute 0, the daily digest at 08:00 UTC, retention at 03:00 UTC, and the stale-Run reaper every minute.
3. In one transaction, it selects active Monitors with an interval where `(epoch_minute - created_at_minute) % interval_minutes = 0`, locking them with `FOR UPDATE SKIP LOCKED`. A Monitor with no interval only runs on demand. Snoozed Monitors are still scheduled: snooze holds back Reactions, never Runs.
4. It inserts a `processing` Run (trigger `schedule`) for each due Monitor and builds its ScrapeJob v3. In the same transaction it flips pending confirm Runs whose `scheduled_for` has passed to `processing` and builds their jobs.
5. After commit, jobs are published to the `monitor_runs` exchange (routing key `monitor_scrape_job`), up to 10 at a time, within a 50-second tick deadline. A job that cannot be published has its Run marked `failed` (`publish_failed`) so it is never left in `processing`.

ScrapeJob v3 (built by `db.BuildScrapeJob`, mirrors `ScrapeJob` in `packages/types/src/protocol.ts`):

```json
{
  "version": 3,
  "run_id": "uuid", "monitor_id": "uuid",
  "url": "https://example.com/pricing",
  "viewport": { "w": 1366, "h": 768 },
  "capture": {
    "screenshot": "png", "full_page": true, "max_height": 8000, "extra_wait_ms": 0,
    "block_ads": true, "block_cookie_banners": true
  },
  "macro_id": "uuid or null",
  "storage_state_key": "state/{monitor_id}.json",
  "env_version": "2026-11-21.1"
}
```

The screenshot is always a full-page PNG: the visual Comparator runs on every Run, and pixel diffs need lossless images. `macro_id` is the Monitor's active Macro version, which the worker replays before capturing; the worker loads its steps from Postgres.

### Evaluating a Capture (event-driven)

1. **Receive.** The browser worker publishes Capture v3 to `monitor_runs.scraped`. The consumer decodes it with unknown fields rejected and checks its invariants (version 3, ids present, a known status, a known `invalid_reason` or an error message where required, a well-formed Macro result, at most 5,000 blocks, unique block ids). A payload that fails is discarded to `dlq.monitor_runs`.
2. **Lock.** The pipeline opens a transaction and takes `pg_advisory_xact_lock(hashtext(monitor_id))`, so two Runs of one Monitor are evaluated one after the other. It loads the Run, the Monitor (with its active Macro and Watch Plan) and its `monitor_state`. A Run that is not found or belongs to another Monitor is a permanent failure. A Run that is already `succeeded` or `failed` is a duplicate delivery: nothing is written and the message is accepted.
3. **Validate.** A Capture with status `invalid` (`http_status`, `challenge`, `empty`, `blank_screenshot`, `cross_domain`, `macro_failed`) or `error` fails the Run with that reason and is never compared. The baselines are not touched. `consecutive_failures` is counted; when it reaches 3, one "this Monitor keeps failing" notification is sent (reason, the last error message, a link to the Monitor page), unless the Monitor is snoozed. The count starts over at the next success.
4. **Partial-load check.** A Capture whose text is under 10 % of a previous Capture longer than 500 characters fails the Run with reason `partial`.
5. **Store the blocks.** The blocks and the worker's mask rectangles are written to `captures/{monitor}/{run}/blocks.json.gz`.
6. **Watch Plan.** A new plan is asked of the agent (`POST {AGENT_URL}/internal/plan`) when this Capture becomes the baseline, when the plan was made for other instructions than the Monitor has now (`sha256(instructions)` differs from `plan.instructions_hash`), and when the plan has not fitted the page for 3 Runs in a row (a watched Section's paths match no block) or the Monitor has had a model connection but no plan for as long. The previous plan is passed along. The answer is guarded: Sections without an id, with a repeated id, with an invalid `how`, or whose paths match no block of the Capture are dropped, at most 24 are kept, and an invalid `rest` becomes `both`. An empty or failed plan leaves `monitors.watch_plan` as it was; planning never fails a Run. The plan is applied to this Run's comparison and saved at the end of the transaction.
7. **Normalize and fingerprint.** Unicode and whitespace canonicalization and volatile-token masking. Blocks the plan does not watch as text (an `ignore` Section, or one watched only as `visual`) are kept but flagged ignored and left out of the text hash. The `captures` row is inserted with `text_hash`, SimHash, the screenshot's dHash and size.
8. **Re-baseline rules.** With no previous Capture, or when the Capture's `env_version` or the capture version differs from what `monitor_state` recorded, this Capture becomes both `previous` and `last_notified`, the Run's verdict is `baseline`, and nothing is compared or sent. The capture version hashes URL, viewport, extra wait, ad blocking and the Macro the Capture was taken with. A Macro repaired by the worker during the Run does not re-baseline: the Capture is compared as usual and the repaired version is recorded for the Runs that follow. The Watch Plan is not part of the version: both sides of every comparison are read under the current plan.
9. **Compare.** The base is `previous`, or, when a Change is pending, the Capture that pending Change started from. The text Comparator always runs; each op is tagged with its Section. The visual Comparator always runs when both screenshots exist. Without a plan it compares the whole page. With a plan it crops each Section watched as `visual` or `both` out of both screenshots (the union rectangle of the Section's blocks on each Capture) and compares crop against crop, with nested Sections and the worker's masks translated into the crop; a Section on one side only is one region covering it; and if `rest` is `visual` or `both`, the page is also compared with every Section masked out. Regions carry their Section id and, where they exist on both sides, their box on the before screenshot.
10. **No counted difference.** Verdict `none` and no model call. If only ignored text differs, the verdict is `noise` with `suppressed_by: ["ignored_section"]`, also without a model call. If a Change was pending, the verdict is `noise` (`did_not_persist`).
11. **Ask the agent.** `POST {AGENT_URL}/internal/compare` with the Monitor's instructions (a default text when empty), connection and model, both Captures' object keys, the counted text ops, the regions, the Watch Plan, the screenshot sizes and the owner's feedback on up to 5 recent Changes. The agent answers whether the difference is relevant, with a one-sentence summary, items citing ops and regions by index, and what it ignored. On a confirm Run that finds the page as the pending Change saw it (same watched text, no visual regions between the two Captures), the pending Change Record's answer is reused instead.
12. **Decide.** Relevant: `change`, or `pending` first when the Monitor has `confirm_changes` on. Not relevant: `noise` (`not_relevant`). When the agent cannot be asked (the Monitor has no model connection, the agent API is unreachable or answers an error) the pipeline fails open: the difference is treated as relevant, with an `agent_unavailable` note, a summary built from the diff, and `agent.unavailable = true` with the error text.
13. **Record.** The agent's items go through the evidence guard: indexes that are out of range (or point at an ignored op) are stripped, an item left with none is dropped, and each item's `rect_before` and `rect_after` are filled from what it cites. The pipeline renders the diff image and first-region crop (when there are regions), builds Change Record version 2, writes it to `changes/{monitor}/{change}.json.gz`, and inserts a `changes` row (`summary`, `item_count`, `agent`, `suppressed_by`, `dimensions`). A notified Change also carries a `cumulative` text section (`last_notified → current`) when Runs in between were Noise.
14. **Update state.** `previous` moves to this Run; `last_notified` moves on every `change`. The pending Change, the failure streak, the plan staleness count and the versions are updated. The Run is marked `succeeded` with its verdict, a `summary` for the timeline ("Baseline captured", "No difference", the agent's sentence, "Seen once, waiting for the next check to confirm"), the Macro it replayed and how that went, and the model usage of the whole Run (Macro repair, plan, comparison).
15. **Queue Reactions.** For `pending`, a confirm Run is inserted: published right after commit when the Monitor's interval is 5 minutes or less, otherwise scheduled at `+min(interval, 5 min)` for the tick to pick up. For `change` on a Monitor that is not snoozed: urgency `hourly` or `daily` inserts a `digest_items` row; urgency `instant` renders the notification for after commit.
16. **Commit, then react.** After the transaction commits, the confirm job is published (its Run is marked `failed` if that fails) and the instant notification is sent through the notifier; `changes.notified_at` is stamped on success. The delivery is then accepted.

**Failure path.** A malformed payload and a Run that does not exist or belongs to another Monitor are discarded to `dlq.monitor_runs`. Any other error (database, object storage) rolls the transaction back and requeues the message; the queue's `x-delivery-limit` of 5 then dead-letters it. Agent failures are not errors: they fail open. Because everything up to the Reactions happens in one transaction and Reactions run only after commit, a retried message never sends twice for rolled-back work.

### Digests and retention

- **Digests.** At minute 0 of every hour the tick sends the `hourly` bucket, and at 08:00 UTC also the `daily` bucket. Unsent items are grouped per owner, rendered as one digest listing each Change's summary, sent, and stamped `sent_at`. An owner whose send fails is counted as failed and retried on the next run.
- **Retention** (daily at 03:00 UTC, idempotent). Changes older than `RETENTION_DAYS` are deleted with their Change Record, diff image and crop. Capture objects (blocks, screenshot) older than that are deleted unless a remaining Change or `monitor_state.previous_run_id` / `last_notified_run_id` references them; the `captures` rows stay, with their keys nulled. Screenshots of Run steps (`steps/{monitor}/{run}/{seq}.webp`) older than that are deleted through their `run_steps` rows, whose `screenshot_key` is then nulled.

---

## Admin API

Internal HTTP API on `SCHEDULER_ADMIN_ADDR` (default `:5210`), started only when `SCHEDULER_ADMIN_TOKEN` is set. Every route except `/internal/health` needs `Authorization: Bearer $SCHEDULER_ADMIN_TOKEN`. The web app calls it from server code after checking that the viewer owns the Monitor; it is not meant to be exposed publicly.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/internal/health` | none | `{ok: true, env_version}` |
| POST | `/internal/monitors/{id}/runs` | `{trigger?: "manual" \| "confirm"}` (default `manual`) | 202 `{run_id}`; 502 `publish_failed` (the Run is marked failed) |
| GET | `/internal/runs/{id}` | none | `{run_id, monitor_id, status, trigger, verdict, invalid_reason, error, summary, macro_id, macro_status, input_tokens, output_tokens, change_id, change_status}`, plus `suppressed_by` and `record_key` when a Change exists |
| POST | `/internal/monitors/{id}/baseline` | `{run_id}` | `{ok: true}`; 400 when the Run has no Capture or belongs to another Monitor |
| POST | `/internal/monitors/{id}/plan` | none | The saved Watch Plan; 400 when the Monitor has no model connection or no Capture yet; 502 `agent_failed` when the agent cannot plan (the saved plan stays) |
| POST | `/internal/compare` | `{from_run, to_run}` | A transient Change Record (not stored); 400 when the Runs belong to different Monitors |
| POST | `/internal/digests/run?bucket=hourly\|daily` | none | `{owners, changes, failed}` |
| POST | `/internal/retention/run` | none | `{changes, captures, step_screenshots, deleted_objects}` |

Notes:

- `trigger: "confirm"` promotes the Monitor's pending confirm Run immediately instead of waiting for its scheduled time.
- "Plan again" plans from the Monitor's latest valid Capture. The agent is called outside the Monitor's lock, and the plan's model usage is added to the Run it planned from.
- `POST /internal/compare` here compares two stored Captures under the Monitor's current Watch Plan without asking the agent: the record holds the evidence and a summary built from it, with status `change` when they differ where the Monitor watches and `noise` otherwise. It is not the agent API's route of the same path.
- Errors are `{"error": {"code", "message"}}`: 400 `invalid_id` / `invalid_body` / `invalid_trigger` / `bad_request`, 401 `unauthorized`, 404 `not_found`, 500 `internal_error`, 502 `publish_failed` / `agent_failed`.

---

## Features and Functionalities

### Scheduling

- Minute-granularity intervals from epoch-minute arithmetic relative to the Monitor's creation time; Monitors without an interval run only on demand.
- `FOR UPDATE SKIP LOCKED` on due Monitors and on pending confirm Runs, so overlapping ticks grab disjoint rows.
- Tick concurrency bounded by `SCHEDULER_MAX_CONCURRENT_TICKS`, publishes bounded to 10 per tick, 50-second tick deadline.
- A publish failure marks the Run failed; no Run is left in `processing` by the dispatcher.

### Capture handling

- Strict Capture v3 decoding (unknown fields rejected), with a golden fixture written from the TypeScript type.
- Invalid Captures fail the Run with a typed reason and never move the baseline. Partial loads are detected against the baseline.
- The Macro result of every Capture is recorded on the Run (`macro_id`, `macro_status`, repair usage); `macro_failed` fails the Run.
- Blocks stored gzipped in object storage; up to 64 Captures' blocks kept in an in-process LRU.

### Normalize and compare

- Unicode NFKC, whitespace, quote and dash folding for comparison; the display keeps the original.
- Volatile tokens are masked by class (`reltime`, `clock`, `today`, `counter`, `nonce`, `copyright`); prices and stock counts are never masked. Nothing configures this.
- Text: unique-block anchoring, similarity pairing, moves, word diff with number tokens, magnitudes (`words_added`, `words_removed`, `blocks_changed`, `moves`, `change_ratio`, `net_added`, `net_removed`). Ignored blocks are aligned and kept as `ignored` ops but never count.
- Visual: per-Capture masks, row alignment with shift detection, pixel diff on aligned bands (`packages/image-diff`, threshold 0.1, one worker per comparison), regions of at least 24 px and 4×4 linked to blocks, `area_ratio`, and a `from_box` for every region that exists on both screenshots.
- Watch Plan: `ignore` and `visual` Sections do not count as text; `visual` and `both` Sections are compared crop against crop, so content inserted elsewhere on the page cannot turn a Section into a changed region; `rest` decides what happens outside the Sections; the longest matching path wins.

### Agent and verdict

- `POST /internal/compare` and `POST /internal/plan` on `AGENT_URL` with bearer `AGENT_TOKEN`, 150 s per call. The request and response bodies mirror `packages/types/src/protocol.ts`.
- Identical Captures and ignored-only differences never reach the model.
- Fail open: no connection, an unreachable agent or an error answer sends the difference as it is, marked `agent_unavailable`.
- Evidence guard and rectangle filling on every item, including answers reused on a confirm Run.
- Optional confirmation (`monitors.confirm_changes`) with confirm Runs; an answer for an unchanged page is reused rather than paid for twice, and a pending Change the agent never reviewed is asked about again.
- Every `noise`, `pending` and `change` carries plain-language reasons (`why`) and is stored with its Change Record.

### Reactions and notifications

- One Change Record rendered to email (HTML and text), Slack Block Kit, Discord embeds, Telegram HTML, and the webhook body (the Change Record version 2 JSON itself, event `change`).
- Every Channel leads with the agent's summary sentence, then the first 5 items as before → after (with the Section's name), then the links. A record without items (the agent was unavailable) shows the first 5 lines of the diff instead.
- Links: "View change" (`{WEB_URL}/changes/{id}`), "This was Noise" (`?feedback=noise`), "Snooze 24 h" on the Monitor page. Image links are signed object-store URLs valid for 7 days.
- "This Monitor keeps failing" alert (event `failure`) once per streak of 3 failed Runs.
- Urgency: instant, hourly digest or daily digest. Snooze records Changes without Reactions.
- Channels: email, Slack, Discord, Telegram, webhook. Each target becomes one message on `notifications` with routing key `email`, `slack`, `discord`, `telegram` or `webhook`. Webhooks are signed by the notifications service.
- The `notification_config` cache is an in-memory, byte-bounded LRU (`SCHEDULER_NOTIFICATION_CACHE_MAX_BYTES`, default 200 MiB) invalidated per user through Postgres `LISTEN notification_config_changed`. While the subscription is down the cache is inactive and every lookup goes to Postgres.

### Observability

- JSON logs via `log/slog` on stdout, level from `LOG_LEVEL` (`debug`, `warn`, `error`, default info).
- Each processed Capture logs `verdict`, `change_id`, `failed`, `invalid_reason`, `duplicate`, `notified` and `digest`. A failed agent call logs the agent API's error code.
- Model usage per Run is in `monitor_runs.input_tokens` / `output_tokens`, and per Change in the record's `agent` section.

---

## Configuration

The Postgres and RabbitMQ URLs are assembled by the shared loader in `services/core/config`; the process exits at startup when a required variable is missing.

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | required | Postgres connection. |
| `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | required | RabbitMQ connection. |
| `RESEND_API_KEY`, `SMTP_MAIL`, `SMTP_SENDER_NAME` | required | Required by the shared loader; not used by this service. |
| `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN` | `""` | Loaded by the shared loader; not used by this service. |
| `LOG_LEVEL` | info | `debug`, `warn` or `error`. |
| `AGENT_URL` | `http://127.0.0.1:5220` | Origin of the agent API served by the browser worker. |
| `AGENT_TOKEN` | unset | Bearer token for the agent API. Without it the agent API refuses every call and every difference is sent as it is (a warning is logged at startup). |
| `SCHEDULER_MAX_CONCURRENT_TICKS` | `2` | Tick goroutines allowed at once. |
| `SCHEDULER_RESULT_WORKERS` | `10` | Captures evaluated concurrently (consumer workers and AMQP credits). Also sizes the Postgres pool. |
| `SCHEDULER_NOTIFICATION_CACHE_MAX_BYTES` | 200 MiB | Notification config cache budget. |
| `SCHEDULER_ADMIN_TOKEN` | unset | Bearer token for the admin API. Unset disables the API (a warning is logged). |
| `SCHEDULER_ADMIN_ADDR` | `:5210` | Admin API listen address. |
| `WEB_URL` | `NEXT_PUBLIC_APP_URL`, else `http://localhost:3000` | Web app origin used in notification links. |
| `ENV_VERSION` | `2026-11-21.1` (`pipeline.DefaultEnvVersion`) | Capture environment version sent with every job. Changing it re-baselines every Monitor silently. |
| `RETENTION_DAYS` | `90` | Age after which Changes, unreferenced Capture objects and Run step screenshots are deleted. |
| `R2_ACCESS_KEY_ID` | unset | When set, the scheduler uses the S3 API; `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and `R2_ACCOUNT_ID` or `R2_ENDPOINT` are then required. |
| `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ACCOUNT_ID` | unset | S3 credentials, bucket and account. |
| `R2_ENDPOINT`, `R2_USE_PATH_STYLE` | unset, `false` | S3 endpoint override and path-style addressing (MinIO). |
| `R2_WORKER_URL` | unset | Object-store Worker origin. Signed URLs point here; without S3 credentials every read and write goes through it (Worker-only mode). |
| `R2_API_TOKEN` | unset | Worker bearer token; required in Worker-only mode. |
| `R2_SIGNING_SECRET` | unset | HMAC key for signed read URLs; must match the Worker and the web app. Without it notifications carry no image links. |

Either `R2_ACCESS_KEY_ID` (S3) or `R2_WORKER_URL` + `R2_API_TOKEN` (Worker-only) must be set, or the scheduler exits at startup.

---

## Operational Notes

- **One evaluation per Monitor at a time.** The pipeline and Accept-as-baseline take `pg_advisory_xact_lock(hashtext(monitor_id))` for the whole transaction. Two concurrent Runs of one Monitor are serialized; the second compares against the first one's result.
- **The agent is called inside the Monitor's transaction.** One evaluation can make a plan call and a compare call, each bounded at 150 s, so a transaction and its lock can be held for up to about five minutes. Three things account for that: the transaction sets `idle_in_transaction_session_timeout` to 10 minutes for itself, so a server-wide setting tuned for short transactions cannot kill it; the pool holds `max(2 × NumCPU, SCHEDULER_RESULT_WORKERS + 8)` connections, so evaluations waiting on a model cannot starve the tick or the admin API; and the Watch Plan is written to `monitors` only at the very end, so that row is never locked while a model is thinking. A second Capture of the same Monitor, and Accept-as-baseline, wait for the lock meanwhile.
- **Requeue versus discard.** Undecodable or structurally invalid Captures and permanent pipeline errors are discarded to `dlq.monitor_runs`. Everything else is requeued; the queue's `x-delivery-limit: 5` bounds the retries before dead-lettering.
- **Idempotent redelivery.** A Capture for a Run that is already `succeeded` or `failed` is accepted without side effects. Blocks are written under a key derived from the Run, so a retried message overwrites them. A retried message asks the agent again.
- **Reactions after commit.** Notifications and confirm-job publishes happen only after the transaction commits, and before the delivery is accepted. A notification publish failure is logged and not retried: on redelivery the Run is already a duplicate.
- **`ENV_VERSION` bump.** Every job carries the scheduler's `env_version`, and the browser worker echoes it in the Capture. Bump `DefaultEnvVersion` (or set `ENV_VERSION`) whenever the capture environment changes (browser build, fonts, locale, stabilization). The next valid Capture of every Monitor then becomes its baseline, with no Change and no notification, and gets a new Watch Plan.
- **Stale Runs are failed after 15 minutes.** Every minute tick fails Runs that have been `processing` for over 15 minutes with error code `timeout`. That happens when the browser worker was down or a message was lost.
- **Worker-only object storage.** Locally, `wrangler dev`'s simulated bucket and MinIO are different buckets. Leave `R2_ACCESS_KEY_ID` empty and set `R2_WORKER_URL`, `R2_API_TOKEN` and `R2_SIGNING_SECRET` so the scheduler, browser worker and web app share one bucket.
- **RabbitMQ topology** is pre-declared from `infra/rabbitmq/definitions.template.json`: `monitor_runs` → `monitor_runs.scheduled` (`monitor_scrape_job`) and `monitor_runs.scraped` (`monitor_scrape_result`), both with `x-delivery-limit: 5` and dead-lettering to `dlq.monitor_runs`; `notifications` → `notifications.{email,slack,discord,telegram,webhook}`. The publisher retries 3 times with exponential backoff (100 ms base), then reconnects once and retries. The consumer has its own connection and reconnects with backoff from 1 s to 30 s.
- **Shutdown.** On `SIGINT`/`SIGTERM` the tick loop stops and waits for in-flight ticks, and the admin server shuts down within 5 s. The process does not wait for in-flight evaluations: they are cancelled with the context (an agent call in flight is abandoned), their transactions roll back, and their unsettled deliveries return to the queue when the connection closes. The publisher is closed with a 10 s deadline.

---

## Testing

From `services/scheduler`:

```bash
# Unit tests (the integration tests skip without POSTGRES_*)
go test ./...

# Everything, including the integration tests, against local Postgres
# (make docker-up && make migrate first)
export $(grep -v '^#' ../../.env | xargs) && go test ./...
```

The integration tests (`internal/pipeline/*_integration_test.go`) run the whole pipeline against Postgres with an in-memory object store, fake Captures, a fake agent and a recording notifier. Each test works on a user of its own and deletes it afterwards, and none of them runs a job over the whole database, so they can share a database with a running stack.

Two golden fixtures tie the Go types to `packages/types`: `internal/changerecord/testdata/change_record.json` (regenerate with `go test ./internal/changerecord/ -update`; `packages/types/src/change-record.test.ts` reads the same file) and `internal/capture/testdata/capture-v3.json`. The rendered notifications in `internal/render/testdata/render` are regenerated with `go test ./internal/render/ -update`.

---

## Current Limitations

- **The agent call holds the Monitor's lock.** A slow model delays the next Run of that Monitor and Accept-as-baseline by up to about five minutes, and a redelivered Capture asks (and pays) the agent again.
- **A Watch Plan that cannot be made is retried at a cost.** When the instructions changed and the agent keeps answering with a plan that does not fit the page, every Run asks again; a missing or stale plan is retried every third Run.
- **Sections are located through blocks.** A Section's rectangle is the union of its blocks' rectangles, so a Section with no block on the page (an image the worker did not report as a block) cannot be cropped and counts as missing.
- **Confirm-Run reuse trusts fingerprints.** The pending answer is reused when the watched text hash matches and the visual Comparator finds no region; its items are re-checked by the evidence guard but not re-read by the model.
- **Failed Runs notify once per streak,** whatever the reasons: the alert carries the reason and message of the third failure only.
- **Notification delivery is best effort.** A failed publish to the notifications exchange is logged and not retried, and the scheduler has no visibility into delivery once the notifications service has the message. Digest owners whose send failed are retried on the next digest run.
- **Orphaned objects on rollback.** Blocks, diff images, crops and Change Records are written before the transaction commits. If it then rolls back, those objects stay until something references them again; retention only deletes objects it finds through database rows.
- **Retention does not remove storage state or recording screenshots.** `state/{monitor}.json` and the step screenshots of Macro recordings (`steps/{monitor}/{macro}/…`) are not covered by the retention job.
- **Digests run at :00 and 08:00 UTC** for everyone, and one `RETENTION_DAYS` applies to every owner.
- **Shutdown does not drain the consumer.** In-flight evaluations are abandoned and redelivered.
- **The admin API has a single shared token** and no per-user authorization; callers must check ownership first.
- **Minute granularity.** Intervals below one minute are not supported, and schedules are aligned to each Monitor's creation minute.
