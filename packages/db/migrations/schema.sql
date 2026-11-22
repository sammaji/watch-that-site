-- WatchThatSite schema.
--
-- One file holds every product table. It runs once on an empty database (after
-- better-auth_migrations.sql, before functions.sql and rls.sql). Later changes
-- go in dated migration_yyyy_mm_dd_<what>.sql files next to it.
--
-- Every row carries its owner (user_id), so the ownership policies in
-- rls.sql apply without joins. There are no organizations: each account is
-- one person, and everything they create is theirs alone.
--
-- Writers:
--   web app (as the signed-in user, through PostgREST): monitors,
--     notification_config, changes.user_feedback/viewed_at
--   web app (server code): provider_connections, virtual_keys, secrets,
--     monitor_secrets, macros (approve, edit)
--   scheduler: monitor_runs, captures, changes, monitor_state, digest_items,
--     monitors.watch_plan
--   browser worker: macros (recording, repair), run_steps
-- draft: made by the create form so the agent can record a Macro before the
-- owner saves; never scheduled and not listed. Saving makes it active.
CREATE TYPE monitor_status AS ENUM('active', 'paused', 'draft');

CREATE TYPE monitor_run_status AS ENUM('pending', 'processing', 'succeeded', 'failed');

CREATE TYPE change_status AS ENUM('change', 'noise', 'pending');

-- The kinds of evidence a Change can carry.
CREATE TYPE change_dimension AS ENUM('text', 'visual');

--------------------------------------------------------------------------------
-- Secrets, the model gateway and model connections
--------------------------------------------------------------------------------
-- Encrypted values: each account's gateway virtual key and the passwords a
-- Macro types. ciphertext is "v1:<iv>:<tag>:<data>" (base64 parts),
-- AES-256-GCM under ENCRYPTION_KEY, with "<id>:<purpose>" as additional
-- authenticated data so a ciphertext copied to another row does not decrypt.
-- Server code only: no role that PostgREST uses is granted anything on this
-- table.
CREATE TABLE secrets (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('virtual_key', 'macro_secret')),
    ciphertext TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every model call goes through our Bifrost gateway (BIFROST_URL), and each
-- account has exactly one Bifrost virtual key: the only credential the Agent
-- ever sends. The key's provider configs decide what it may reach: the `wts`
-- provider (the platform credit, with the credit as its budget) and one entry
-- per connection the owner added, limited to that connection's own provider
-- key. Named uuidv5(user id, WTS_VIRTUAL_KEY_NAMESPACE) in Bifrost (see
-- apps/web/lib/bifrost.ts). Created by the web app the first time a signed-in
-- user needs it. Server code only.
CREATE TABLE virtual_keys (
    user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    -- Bifrost's id and name for the key
    bifrost_id TEXT NOT NULL UNIQUE,
    bifrost_name TEXT NOT NULL UNIQUE,
    -- the key's value ("sk-bf-..."), sealed with purpose 'virtual_key'
    secret_id UUID NOT NULL REFERENCES secrets (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A model provider the Agent can use for the owner's Monitors. Requests never
-- go anywhere from our servers but the gateway, with the account's virtual
-- key; the gateway holds the provider credentials.
--   - managed: the platform credit every account gets. kind and Bifrost
--     provider `wts`, no key of its own (the gateway's routing rules pin
--     ours), models PLATFORM_MODELS. Created and kept by the server; the
--     owner can neither edit nor delete it.
--   - a provider Bifrost supports (kind `openai`, `anthropic`, `azure`,
--     `bedrock`, `vertex`, `gemini`, ...): a key on that Bifrost provider,
--     named after this row's id.
--   - a custom endpoint (base_url set, kind `openai` or `anthropic` for the
--     API it speaks): Bifrost keeps base URLs per provider, so the connection
--     gets a custom provider of its own, `c-<first 16 hex digits of id>`,
--     holding its one key.
CREATE TABLE provider_connections (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    name TEXT NOT NULL,
    -- a custom endpoint's URL as the owner entered it (normalized); NULL for
    -- a provider's own endpoint, and always NULL on the managed row
    base_url TEXT,
    -- the provider's settings that are not secret, for display: Azure
    -- endpoint, api_version and deployments, Bedrock region, Vertex
    -- project_id and region, a self-hosted server's url, ... Secrets (keys,
    -- secret access keys, service-account JSON) are stored only in Bifrost.
    settings JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- the Bifrost provider this connection's models live under
    gateway_provider TEXT NOT NULL,
    -- the Bifrost provider key holding the owner's credentials; NULL on the
    -- managed row
    gateway_key_id TEXT UNIQUE,
    -- last four characters of the key, for display ('' when there is none)
    api_key_hint TEXT NOT NULL DEFAULT '',
    -- Bifrost model strings the owner enabled, "<gateway_provider>/<model>",
    -- e.g. ["openai/gpt-6.1-sol", "azure/gpt-4o", "wts/wts-pro"]
    models JSONB NOT NULL DEFAULT '[]'::JSONB,
    default_model TEXT,
    managed BOOLEAN NOT NULL DEFAULT FALSE,
    -- whether the key works is the gateway's to say: the API reads each key's
    -- status from Bifrost, which lists models with it when it is added and
    -- again in the background
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (managed = (gateway_key_id IS NULL)),
    CHECK (NOT managed OR (kind = 'wts' AND gateway_provider = 'wts' AND base_url IS NULL)),
    CHECK (base_url IS NULL OR kind IN ('openai', 'anthropic'))
);

CREATE INDEX provider_connections_user_id_idx ON provider_connections (user_id);

-- At most one platform-credit connection per account.
CREATE UNIQUE INDEX provider_connections_one_managed_idx ON provider_connections (user_id)
WHERE
    managed;

-- Per-account settings. One row per account, created on first save.
CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    -- The model for small jobs that are not a Monitor's: suggesting a new
    -- Monitor's Instructions from its page. NULL: the platform credit's
    -- cheapest model.
    utility_connection_id UUID REFERENCES provider_connections (id) ON DELETE SET NULL,
    utility_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

--------------------------------------------------------------------------------
-- Monitors and Runs
--------------------------------------------------------------------------------
CREATE TABLE monitors (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    -- NULL: runs on demand only
    interval_minutes INTEGER,
    -- what to watch for and what to ignore, in the owner's words; the agent
    -- reads this on every Run that finds a difference
    instructions TEXT NOT NULL DEFAULT '',
    -- the model the agent uses for this Monitor
    connection_id UUID REFERENCES provider_connections (id) ON DELETE SET NULL,
    model TEXT,
    -- how the Agent decided the page should be watched: Sections, each
    -- watched as text, visual, both, or ignored (WatchPlan in
    -- packages/types/src/watch-plan.ts). NULL until the first plan is made:
    -- the whole page is then watched as text and visual.
    watch_plan JSONB,
    -- re-check a Change on the next Run before alerting
    confirm_changes BOOLEAN NOT NULL DEFAULT FALSE,
    urgency TEXT NOT NULL DEFAULT 'instant' CHECK (urgency IN ('instant', 'hourly', 'daily')),
    snoozed_until TIMESTAMPTZ,
    extra_wait_ms INTEGER NOT NULL DEFAULT 0 CHECK (extra_wait_ms BETWEEN 0 AND 20000),
    block_ads BOOLEAN NOT NULL DEFAULT TRUE,
    viewport_w INTEGER NOT NULL DEFAULT 1366,
    viewport_h INTEGER NOT NULL DEFAULT 768,
    status monitor_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX monitors_user_id_idx ON monitors (user_id);


CREATE INDEX monitors_interval_minutes_idx ON monitors (interval_minutes);

-- A Macro version: the ordered browser actions replayed before each Capture.
-- A Monitor has at most one active version. Recording by the agent goes
-- recording -> draft (waiting for the owner's approval) or failed; approving a
-- draft makes it active and archives the previous active version. A repair
-- made during a Run is inserted as active straight away.
CREATE TABLE macros (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('recording', 'draft', 'active', 'archived', 'failed')),
    -- who produced this version: the agent from a goal, a person, or a repair
    source TEXT NOT NULL CHECK (source IN ('agent', 'user', 'repair')),
    -- what the owner asked for, e.g. "Sign in and open the Billing tab"
    goal TEXT NOT NULL DEFAULT '',
    -- MacroStep[] (packages/types/src/macro.ts)
    steps JSONB NOT NULL DEFAULT '[]'::JSONB,
    -- what changed in this version, or why recording failed
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (monitor_id, version)
);

CREATE UNIQUE INDEX macros_one_active_idx ON macros (monitor_id)
WHERE
    status = 'active';

-- Named secrets a Monitor's Macro may type, referenced from a step value as
-- {{secret:<name>}}. The value lives in secrets; hint is for display.
CREATE TABLE monitor_secrets (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
    secret_id UUID NOT NULL REFERENCES secrets (id) ON DELETE RESTRICT,
    hint TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (monitor_id, name)
);

CREATE TABLE monitor_runs (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status monitor_run_status NOT NULL DEFAULT 'pending',
    trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual', 'confirm')),
    -- confirm Runs wait here until the minute tick picks them up
    scheduled_for TIMESTAMPTZ,
    -- {code, message, occurred_at}; set when the Run failed
    error JSONB,
    -- why the Capture was rejected (http_status, challenge, macro_failed, ...)
    invalid_reason TEXT,
    -- outcome of a succeeded Run; the change row, if any, holds the evidence
    verdict TEXT CHECK (verdict IN ('baseline', 'none', 'noise', 'pending', 'change')),
    -- a few words on what the Run concluded, shown on the timeline
    summary TEXT,
    -- the Macro version replayed, and how it went: ok | repaired | failed
    macro_id UUID REFERENCES macros (id) ON DELETE SET NULL,
    macro_status TEXT CHECK (macro_status IN ('ok', 'repaired', 'failed')),
    -- model usage across the Run: Macro repair plus the comparison
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX monitor_runs_user_id_idx ON monitor_runs (user_id);

-- The Monitor page lists a Monitor's recent Runs newest first, and the Runs
-- page filters them by status.
CREATE INDEX monitor_runs_monitor_created_idx ON monitor_runs (monitor_id, created_at DESC);

CREATE INDEX monitor_runs_status_created_idx ON monitor_runs (status, created_at DESC);

-- The minute tick picks up confirm Runs whose time has come.
CREATE INDEX monitor_runs_due_confirm_idx ON monitor_runs (scheduled_for)
WHERE
    status = 'pending'
    AND scheduled_for IS NOT NULL;

-- What happened during a Run or a Macro recording, one row per step: each
-- Macro step replayed, each repair, each thing the agent did while recording,
-- and each tool the agent used while comparing. Exactly one of run_id and
-- macro_id is set: a Run's trace, or a recording's.
CREATE TABLE run_steps (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    run_id UUID REFERENCES monitor_runs (id) ON DELETE CASCADE,
    macro_id UUID REFERENCES macros (id) ON DELETE CASCADE,
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('macro', 'repair', 'record', 'plan', 'compare')),
    -- the Macro step type or the agent tool name
    kind TEXT NOT NULL,
    -- one line a person can read: "Click 'Annual'"
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'repaired', 'skipped')),
    -- error message, the selector that matched, what the agent said, ...
    detail JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- R2: steps/{monitor}/{run or macro}/{seq}.webp
    screenshot_key TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((run_id IS NULL) <> (macro_id IS NULL))
);

CREATE INDEX run_steps_run_idx ON run_steps (run_id, seq)
WHERE
    run_id IS NOT NULL;

CREATE INDEX run_steps_macro_idx ON run_steps (macro_id, seq)
WHERE
    macro_id IS NOT NULL;

--------------------------------------------------------------------------------
-- Captures, Changes and the Monitor's baselines
--------------------------------------------------------------------------------
-- One per valid Capture. The fingerprints outlive the R2 objects: retention
-- nulls the keys but keeps the row.
CREATE TABLE captures (
    run_id UUID PRIMARY KEY REFERENCES monitor_runs (id) ON DELETE CASCADE,
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- sha256 of the normalized block text
    text_hash BYTEA NOT NULL,
    simhash BIGINT NOT NULL,
    dhash BIGINT,
    -- R2: captures/{monitor}/{run}/blocks.json.gz
    blocks_key TEXT,
    -- R2: captures/{monitor}/{run}/shot.{webp|png}
    screenshot_key TEXT,
    -- http status, title, stable, env_version, sizes, timings
    meta JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX captures_monitor_created_idx ON captures (monitor_id, created_at DESC);

-- One per Run whose Capture differs from the baseline, whatever the verdict.
CREATE TABLE changes (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    run_id UUID NOT NULL REFERENCES monitor_runs (id) ON DELETE CASCADE,
    from_run_id UUID NOT NULL REFERENCES monitor_runs (id) ON DELETE CASCADE,
    status change_status NOT NULL,
    dimensions change_dimension[] NOT NULL DEFAULT '{}',
    -- why a noise row did not alert: not_relevant, did_not_persist
    suppressed_by TEXT[] NOT NULL DEFAULT '{}',
    -- words_added, words_removed, area_ratio, ...
    magnitude JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- the agent's one-sentence answer
    summary TEXT,
    -- how many items the agent reported
    item_count INTEGER NOT NULL DEFAULT 0,
    -- {relevant, importance, model, unavailable, error, usage, steps}
    agent JSONB,
    -- R2: changes/{monitor}/{id}.json.gz (the Change Record)
    record_key TEXT,
    -- R2: changes/{monitor}/{id}-diff.png
    diff_image_key TEXT,
    -- R2: changes/{monitor}/{id}-crop.png
    crop_key TEXT,
    -- 'useful' | 'noise' | NULL
    user_feedback TEXT CHECK (user_feedback IN ('useful', 'noise')),
    viewed_at TIMESTAMPTZ,
    notified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX changes_monitor_created_idx ON changes (monitor_id, created_at DESC);

CREATE INDEX changes_monitor_change_idx ON changes (monitor_id, created_at DESC)
WHERE
    status = 'change';

CREATE INDEX changes_run_id_idx ON changes (run_id);

-- One row per Monitor: its baselines.
CREATE TABLE monitor_state (
    monitor_id UUID PRIMARY KEY REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- the last valid Capture: every verdict is computed against it
    previous_run_id UUID REFERENCES monitor_runs (id) ON DELETE SET NULL,
    -- the Capture at the last Change: notifications render from it
    last_notified_run_id UUID REFERENCES monitor_runs (id) ON DELETE SET NULL,
    pending_change_id UUID REFERENCES changes (id) ON DELETE SET NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    -- consecutive Runs on which a watched Section of the Watch Plan matched
    -- nothing on the page; at 3 the scheduler asks for a new plan
    plan_stale_runs INTEGER NOT NULL DEFAULT 0,
    storage_state_key TEXT,
    env_version TEXT,
    -- hash of the settings that change what is captured (URL, viewport, the
    -- active Macro, ...); a new value re-baselines silently
    capture_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Changes waiting for an hourly or daily digest.
CREATE TABLE digest_items (
    change_id UUID PRIMARY KEY REFERENCES changes (id) ON DELETE CASCADE,
    monitor_id UUID NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    bucket TEXT NOT NULL CHECK (bucket IN ('hourly', 'daily')),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX digest_items_unsent_idx ON digest_items (bucket, created_at)
WHERE
    sent_at IS NULL;

--------------------------------------------------------------------------------
-- Notification Channels
--------------------------------------------------------------------------------
-- Per-user/org credentials for a connected Channel.
CREATE TABLE notification_config (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    credentials JSONB NOT NULL DEFAULT '{}'::JSONB,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    important BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, channel_id)
);

CREATE INDEX notification_config_user_id_idx ON notification_config (user_id);


CREATE INDEX notification_config_channel_id_idx ON notification_config (channel_id);

-- The scheduler caches notification_config and listens for this to drop
-- stale entries.
CREATE FUNCTION notify_notification_config_change () RETURNS TRIGGER AS $$
DECLARE
    payload jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        payload := jsonb_build_object(
            'channel_id', OLD.channel_id,
            'user_id', OLD.user_id
        );
    ELSE
        payload := jsonb_build_object(
            'channel_id', NEW.channel_id,
            'user_id', NEW.user_id
        );
    END IF;

    PERFORM pg_notify('notification_config_changed', payload::text);

    IF TG_OP = 'UPDATE' AND OLD.channel_id != NEW.channel_id THEN
        PERFORM pg_notify('notification_config_changed', jsonb_build_object(
            'channel_id', OLD.channel_id,
            'user_id', OLD.user_id
        )::text);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_config_change_trigger
AFTER INSERT
OR
UPDATE
OR DELETE ON notification_config FOR EACH ROW
EXECUTE FUNCTION notify_notification_config_change ();
