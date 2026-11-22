package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

// querier is what both the pool and a transaction offer, so every query is
// written once and used from either.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// PgxStore is the pgx-backed Store implementation.
type PgxStore struct {
	pool *pgxpool.Pool
}

var _ Store = (*PgxStore)(nil)

// NewStore returns a Store backed by the given connection pool.
func NewStore(pool *pgxpool.Pool) *PgxStore {
	return &PgxStore{pool: pool}
}

// Pool exposes the underlying pool for components that need raw access (the
// LISTEN/NOTIFY Listener).
func (s *PgxStore) Pool() *pgxpool.Pool { return s.pool }

// pgxTx implements Tx over one transaction.
type pgxTx struct {
	tx pgx.Tx
}

var _ Tx = pgxTx{}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

// ScheduleDueRuns runs the whole scheduling transaction. Due Monitors are
// selected with SKIP LOCKED so concurrent ticks grab disjoint rows. Every
// active Monitor is schedulable: the first Run establishes the baseline, and
// snooze only holds back notifications, never Runs.
func (s *PgxStore) ScheduleDueRuns(ctx context.Context, epochMinutes int, now time.Time, envVersion string) ([]ScrapeJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	due, err := loadDueMonitors(ctx, tx, epochMinutes)
	if err != nil {
		return nil, err
	}

	jobs := make([]ScrapeJob, 0, len(due))
	for _, d := range due {
		run, err := insertRun(ctx, tx, d.cfg, TriggerSchedule, RunProcessing, nil)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, BuildScrapeJob(d.cfg, run.ID, envVersion))
	}

	confirms, err := promoteDueConfirmRuns(ctx, tx, now, envVersion)
	if err != nil {
		return nil, err
	}
	jobs = append(jobs, confirms...)

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}
	return jobs, nil
}

type dueMonitor struct {
	cfg             monitor.Config
	storageStateKey *string
}

func loadDueMonitors(ctx context.Context, tx pgx.Tx, epochMinutes int) ([]dueMonitor, error) {
	query := `
		WITH due AS (
			SELECT id
			FROM monitors
			WHERE status = 'active'
			  AND interval_minutes IS NOT NULL
			  AND interval_minutes > 0
			  AND ($1 - EXTRACT(EPOCH FROM created_at)::BIGINT / 60) % interval_minutes = 0
			ORDER BY id
			FOR UPDATE SKIP LOCKED
		)
		SELECT ` + monitorColumns + `, st.storage_state_key
		FROM due
		JOIN monitors m ON m.id = due.id
		LEFT JOIN monitor_state st ON st.monitor_id = m.id
	`
	rows, err := tx.Query(ctx, query, epochMinutes)
	if err != nil {
		return nil, fmt.Errorf("load due monitors (epoch_min=%d): %w", epochMinutes, err)
	}
	defer rows.Close()

	var out []dueMonitor
	for rows.Next() {
		var d dueMonitor
		cfg, err := scanMonitor(rows, &d.storageStateKey)
		if err != nil {
			return nil, fmt.Errorf("scan due monitor: %w", err)
		}
		d.cfg = cfg
		out = append(out, d)
	}
	return out, rows.Err()
}

// promoteDueConfirmRuns flips pending confirm Runs whose scheduled_for has
// passed to processing and returns their jobs.
func promoteDueConfirmRuns(ctx context.Context, tx pgx.Tx, now time.Time, envVersion string) ([]ScrapeJob, error) {
	rows, err := tx.Query(ctx, `
		UPDATE monitor_runs r
		SET status = 'processing', updated_at = NOW()
		WHERE r.id IN (
			SELECT id FROM monitor_runs
			WHERE status = 'pending' AND scheduled_for IS NOT NULL AND scheduled_for <= $1
			ORDER BY scheduled_for
			FOR UPDATE SKIP LOCKED
		)
		RETURNING r.id, r.monitor_id
	`, now)
	if err != nil {
		return nil, fmt.Errorf("promote confirm runs: %w", err)
	}
	type promoted struct{ runID, monitorID string }
	var ids []promoted
	for rows.Next() {
		var p promoted
		if err := rows.Scan(&p.runID, &p.monitorID); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	jobs := make([]ScrapeJob, 0, len(ids))
	for _, p := range ids {
		cfg, err := getMonitor(ctx, tx, p.monitorID)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, BuildScrapeJob(cfg, p.runID, envVersion))
	}
	return jobs, nil
}

// CreateRun inserts a processing Run for one Monitor. A confirm request
// promotes the Monitor's pending confirm Run when there is one.
func (s *PgxStore) CreateRun(ctx context.Context, monitorID, trigger, envVersion string) (ScrapeJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ScrapeJob{}, fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	cfg, err := getMonitor(ctx, tx, monitorID)
	if err != nil {
		return ScrapeJob{}, err
	}
	var runID string
	if trigger == TriggerConfirm {
		err := tx.QueryRow(ctx, `
			UPDATE monitor_runs SET status = 'processing', updated_at = NOW()
			WHERE id = (
				SELECT id FROM monitor_runs
				WHERE monitor_id = $1 AND trigger = 'confirm' AND status = 'pending'
				ORDER BY created_at DESC LIMIT 1
				FOR UPDATE
			)
			RETURNING id
		`, monitorID).Scan(&runID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return ScrapeJob{}, fmt.Errorf("promote confirm run: %w", err)
		}
	}
	if runID == "" {
		run, err := insertRun(ctx, tx, cfg, trigger, RunProcessing, nil)
		if err != nil {
			return ScrapeJob{}, err
		}
		runID = run.ID
	}

	if err := tx.Commit(ctx); err != nil {
		return ScrapeJob{}, fmt.Errorf("commit transaction: %w", err)
	}
	return BuildScrapeJob(cfg, runID, envVersion), nil
}

func insertRun(ctx context.Context, q querier, cfg monitor.Config, trigger, status string, scheduledFor *time.Time) (Run, error) {
	run := Run{MonitorID: cfg.ID, UserID: cfg.UserID, Status: status, Trigger: trigger, ScheduledFor: scheduledFor}
	err := q.QueryRow(ctx, `
		INSERT INTO monitor_runs (monitor_id, user_id, status, trigger, scheduled_for)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at
	`, cfg.ID, cfg.UserID, status, trigger, scheduledFor).Scan(&run.ID, &run.CreatedAt)
	if err != nil {
		return Run{}, fmt.Errorf("insert run: %w", err)
	}
	return run, nil
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

// monitorColumns reads a Monitor with the id of its active Macro version, of
// which there is at most one (macros_one_active_idx).
const monitorColumns = `
	m.id, m.user_id, m.name, m.url, m.interval_minutes,
	m.instructions, m.connection_id, m.model, m.watch_plan, m.confirm_changes,
	m.urgency, m.snoozed_until, m.extra_wait_ms, m.block_ads, m.viewport_w,
	m.viewport_h, m.status::TEXT,
	(SELECT mc.id FROM macros mc WHERE mc.monitor_id = m.id AND mc.status = 'active')`

// scanMonitor scans monitorColumns plus any extra destinations.
func scanMonitor(row pgx.Row, extra ...any) (monitor.Config, error) {
	var (
		cfg      monitor.Config
		interval *int
		plan     []byte
	)
	dest := []any{
		&cfg.ID, &cfg.UserID, &cfg.Name, &cfg.URL, &interval,
		&cfg.Instructions, &cfg.ConnectionID, &cfg.Model, &plan, &cfg.ConfirmChanges,
		&cfg.Urgency, &cfg.SnoozedUntil, &cfg.ExtraWaitMS, &cfg.BlockAds, &cfg.ViewportW,
		&cfg.ViewportH, &cfg.Status, &cfg.ActiveMacroID,
	}
	if err := row.Scan(append(dest, extra...)...); err != nil {
		return monitor.Config{}, err
	}
	if interval != nil {
		cfg.IntervalMin = *interval
	}
	cfg.WatchPlan = decodeWatchPlan(plan)
	return cfg, nil
}

// decodeWatchPlan reads monitors.watch_plan. The owner can edit the plan in
// the web app, so a value this code cannot read is treated as no plan (the
// whole page is watched) rather than failing every Run of the Monitor.
func decodeWatchPlan(raw []byte) *monitor.WatchPlan {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var plan monitor.WatchPlan
	if err := json.Unmarshal(raw, &plan); err != nil {
		return nil
	}
	return &plan
}

func getMonitor(ctx context.Context, q querier, monitorID string) (monitor.Config, error) {
	cfg, err := scanMonitor(q.QueryRow(ctx, `SELECT `+monitorColumns+` FROM monitors m WHERE m.id = $1`, monitorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return monitor.Config{}, fmt.Errorf("monitor %s: %w", monitorID, ErrNotFound)
	}
	if err != nil {
		return monitor.Config{}, fmt.Errorf("get monitor %s: %w", monitorID, err)
	}
	return cfg, nil
}

func (s *PgxStore) GetMonitor(ctx context.Context, monitorID string) (monitor.Config, error) {
	return getMonitor(ctx, s.pool, monitorID)
}

func (t pgxTx) GetMonitor(ctx context.Context, monitorID string) (monitor.Config, error) {
	return getMonitor(ctx, t.tx, monitorID)
}

func saveWatchPlan(ctx context.Context, q querier, monitorID string, plan monitor.WatchPlan) error {
	raw, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	// The Agent decides the wait along with the plan; later Captures use it.
	tag, err := q.Exec(ctx, `UPDATE monitors SET watch_plan = $2, extra_wait_ms = $3 WHERE id = $1`, monitorID, raw, plan.WaitMS)
	if err != nil {
		return fmt.Errorf("save watch plan of %s: %w", monitorID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("save watch plan of %s: %w", monitorID, ErrNotFound)
	}
	return nil
}

func (s *PgxStore) SaveWatchPlan(ctx context.Context, monitorID string, plan monitor.WatchPlan) error {
	return saveWatchPlan(ctx, s.pool, monitorID, plan)
}

func (t pgxTx) SaveWatchPlan(ctx context.Context, monitorID string, plan monitor.WatchPlan) error {
	return saveWatchPlan(ctx, t.tx, monitorID, plan)
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const runColumns = `id, monitor_id, user_id, status::TEXT, trigger, verdict, invalid_reason, error,
	summary, macro_id, macro_status, input_tokens, output_tokens, scheduled_for, created_at`

func getRun(ctx context.Context, q querier, runID string) (Run, error) {
	var r Run
	err := q.QueryRow(ctx, `SELECT `+runColumns+` FROM monitor_runs WHERE id = $1`, runID).Scan(
		&r.ID, &r.MonitorID, &r.UserID, &r.Status, &r.Trigger, &r.Verdict,
		&r.InvalidReason, &r.Error, &r.Summary, &r.MacroID, &r.MacroStatus, &r.InputTokens, &r.OutputTokens,
		&r.ScheduledFor, &r.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, fmt.Errorf("run %s: %w", runID, ErrNotFound)
	}
	if err != nil {
		return Run{}, fmt.Errorf("get run %s: %w", runID, err)
	}
	return r, nil
}

func (s *PgxStore) FailStaleRuns(ctx context.Context, before time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE monitor_runs
		SET status = 'failed',
			error = jsonb_build_object(
				'code', 'timeout',
				'message', 'No Capture arrived for this Run; the browser worker may have been down.',
				'occurred_at', NOW()),
			summary = 'No Capture arrived for this Run; the browser worker may have been down.',
			updated_at = NOW()
		WHERE status = 'processing' AND updated_at < $1
	`, before)
	if err != nil {
		return 0, fmt.Errorf("fail stale runs: %w", err)
	}
	return tag.RowsAffected(), nil
}

func (s *PgxStore) GetRun(ctx context.Context, runID string) (Run, error) {
	return getRun(ctx, s.pool, runID)
}

func (t pgxTx) GetRun(ctx context.Context, runID string) (Run, error) {
	return getRun(ctx, t.tx, runID)
}

func (t pgxTx) InsertRun(ctx context.Context, cfg monitor.Config, trigger, status string, scheduledFor *time.Time) (Run, error) {
	return insertRun(ctx, t.tx, cfg, trigger, status, scheduledFor)
}

func (s *PgxStore) AddRunTokens(ctx context.Context, runID string, input, output int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE monitor_runs
		SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3
		WHERE id = $1
	`, runID, input, output)
	if err != nil {
		return fmt.Errorf("add tokens to run %s: %w", runID, err)
	}
	return nil
}

// The Macro a Run replayed is written through a subquery: the version may
// have been deleted since the job was sent, and a dangling id would fail the
// whole evaluation on the foreign key.
const setRunOutcome = `
	summary = $4,
	macro_id = (SELECT id FROM macros WHERE id = $5::uuid),
	macro_status = $6,
	input_tokens = $7,
	output_tokens = $8,
	updated_at = NOW()`

func markRunFailed(ctx context.Context, q querier, runID string, runErr RunError, invalidReason *string, outcome RunOutcome) error {
	if runErr.OccurredAt.IsZero() {
		runErr.OccurredAt = time.Now().UTC()
	}
	if outcome.Summary == "" {
		outcome.Summary = runErr.Message
	}
	raw, err := json.Marshal(runErr)
	if err != nil {
		return err
	}
	tag, err := q.Exec(ctx, `
		UPDATE monitor_runs
		SET status = 'failed', error = $2, invalid_reason = $3, verdict = NULL,`+setRunOutcome+`
		WHERE id = $1
	`, runID, raw, invalidReason, outcome.Summary, outcome.MacroID, outcome.MacroStatus, outcome.InputTokens, outcome.OutputTokens)
	if err != nil {
		return fmt.Errorf("mark run %s failed: %w", runID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("mark run %s failed: %w", runID, ErrNotFound)
	}
	return nil
}

func (s *PgxStore) MarkRunFailed(ctx context.Context, runID string, runErr RunError) error {
	return markRunFailed(ctx, s.pool, runID, runErr, nil, RunOutcome{})
}

func (t pgxTx) MarkRunFailed(ctx context.Context, runID string, runErr RunError, invalidReason *string, outcome RunOutcome) error {
	return markRunFailed(ctx, t.tx, runID, runErr, invalidReason, outcome)
}

func (t pgxTx) MarkRunSucceeded(ctx context.Context, runID, verdict string, outcome RunOutcome) error {
	var noReason *string
	_, err := t.tx.Exec(ctx, `
		UPDATE monitor_runs
		SET status = 'succeeded', verdict = $2, error = NULL, invalid_reason = $3,`+setRunOutcome+`
		WHERE id = $1
	`, runID, verdict, noReason, outcome.Summary, outcome.MacroID, outcome.MacroStatus, outcome.InputTokens, outcome.OutputTokens)
	if err != nil {
		return fmt.Errorf("mark run %s succeeded: %w", runID, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Monitor state
// ---------------------------------------------------------------------------

func getState(ctx context.Context, q querier, monitorID string) (State, bool, error) {
	var s State
	err := q.QueryRow(ctx, `
		SELECT monitor_id, previous_run_id, last_notified_run_id, pending_change_id,
		       consecutive_failures, plan_stale_runs, storage_state_key, env_version, capture_version
		FROM monitor_state WHERE monitor_id = $1
	`, monitorID).Scan(
		&s.MonitorID, &s.PreviousRunID, &s.LastNotifiedRunID, &s.PendingChangeID,
		&s.ConsecutiveFailures, &s.PlanStaleRuns, &s.StorageStateKey, &s.EnvVersion, &s.CaptureVersion,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return State{MonitorID: monitorID}, false, nil
	}
	if err != nil {
		return State{}, false, fmt.Errorf("get state of %s: %w", monitorID, err)
	}
	return s, true, nil
}

func (s *PgxStore) GetState(ctx context.Context, monitorID string) (State, bool, error) {
	return getState(ctx, s.pool, monitorID)
}

func (t pgxTx) GetState(ctx context.Context, monitorID string) (State, bool, error) {
	return getState(ctx, t.tx, monitorID)
}

func (t pgxTx) SaveState(ctx context.Context, cfg monitor.Config, s State) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO monitor_state (
			monitor_id, user_id, previous_run_id, last_notified_run_id,
			pending_change_id, consecutive_failures, plan_stale_runs, storage_state_key,
			env_version, capture_version
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (monitor_id) DO UPDATE SET
			previous_run_id = EXCLUDED.previous_run_id,
			last_notified_run_id = EXCLUDED.last_notified_run_id,
			pending_change_id = EXCLUDED.pending_change_id,
			consecutive_failures = EXCLUDED.consecutive_failures,
			plan_stale_runs = EXCLUDED.plan_stale_runs,
			storage_state_key = EXCLUDED.storage_state_key,
			env_version = EXCLUDED.env_version,
			capture_version = EXCLUDED.capture_version,
			updated_at = NOW()
	`, cfg.ID, cfg.UserID, s.PreviousRunID, s.LastNotifiedRunID,
		s.PendingChangeID, s.ConsecutiveFailures, s.PlanStaleRuns, s.StorageStateKey,
		s.EnvVersion, s.CaptureVersion)
	if err != nil {
		return fmt.Errorf("save state of %s: %w", cfg.ID, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

func getCapture(ctx context.Context, q querier, runID string) (CaptureRow, error) {
	var (
		c       CaptureRow
		simhash int64
		dhash   *int64
	)
	err := q.QueryRow(ctx, `
		SELECT run_id, monitor_id, user_id, text_hash, simhash, dhash,
		       blocks_key, screenshot_key, meta, created_at
		FROM captures WHERE run_id = $1
	`, runID).Scan(&c.RunID, &c.MonitorID, &c.UserID, &c.TextHash, &simhash, &dhash,
		&c.BlocksKey, &c.ScreenshotKey, &c.Meta, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return CaptureRow{}, fmt.Errorf("capture %s: %w", runID, ErrNotFound)
	}
	if err != nil {
		return CaptureRow{}, fmt.Errorf("get capture %s: %w", runID, err)
	}
	c.SimHash = uint64(simhash)
	if dhash != nil {
		v := uint64(*dhash)
		c.DHash = &v
	}
	return c, nil
}

func (s *PgxStore) GetCapture(ctx context.Context, runID string) (CaptureRow, error) {
	return getCapture(ctx, s.pool, runID)
}

func (t pgxTx) GetCapture(ctx context.Context, runID string) (CaptureRow, error) {
	return getCapture(ctx, t.tx, runID)
}

func (t pgxTx) InsertCapture(ctx context.Context, c CaptureRow) error {
	var dhash *int64
	if c.DHash != nil {
		v := int64(*c.DHash)
		dhash = &v
	}
	meta := c.Meta
	if len(meta) == 0 {
		meta = json.RawMessage(`{}`)
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO captures (run_id, monitor_id, user_id, text_hash, simhash, dhash,
		                      blocks_key, screenshot_key, meta)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (run_id) DO NOTHING
	`, c.RunID, c.MonitorID, c.UserID, c.TextHash, int64(c.SimHash), dhash,
		c.BlocksKey, c.ScreenshotKey, []byte(meta))
	if err != nil {
		return fmt.Errorf("insert capture %s: %w", c.RunID, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

const changeColumns = `id, monitor_id, user_id, run_id, from_run_id, status::TEXT,
	dimensions::TEXT[], suppressed_by, magnitude, COALESCE(summary, ''), item_count, agent,
	record_key, diff_image_key, crop_key, user_feedback, viewed_at, notified_at, created_at`

func scanChange(row pgx.Row) (ChangeRow, error) {
	var c ChangeRow
	var status string
	err := row.Scan(&c.ID, &c.MonitorID, &c.UserID, &c.RunID, &c.FromRunID, &status,
		&c.Dimensions, &c.SuppressedBy, &c.Magnitude, &c.Summary, &c.ItemCount, &c.Agent,
		&c.RecordKey, &c.DiffImageKey, &c.CropKey, &c.UserFeedback, &c.ViewedAt, &c.NotifiedAt, &c.CreatedAt)
	c.Status = decide.Status(status)
	return c, err
}

func (t pgxTx) GetChange(ctx context.Context, id string) (ChangeRow, error) {
	c, err := scanChange(t.tx.QueryRow(ctx, `SELECT `+changeColumns+` FROM changes WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ChangeRow{}, fmt.Errorf("change %s: %w", id, ErrNotFound)
	}
	return c, err
}

func (s *PgxStore) GetChangeByRun(ctx context.Context, runID string) (*ChangeRow, error) {
	c, err := scanChange(s.pool.QueryRow(ctx, `SELECT `+changeColumns+` FROM changes WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get change of run %s: %w", runID, err)
	}
	return &c, nil
}

func (t pgxTx) RecentChangeFeedback(ctx context.Context, monitorID string, limit int) ([]ChangeFeedback, error) {
	rows, err := t.tx.Query(ctx, `
		SELECT summary, user_feedback
		FROM changes
		WHERE monitor_id = $1 AND user_feedback IS NOT NULL AND COALESCE(summary, '') <> ''
		ORDER BY created_at DESC
		LIMIT $2
	`, monitorID, limit)
	if err != nil {
		return nil, fmt.Errorf("recent change feedback: %w", err)
	}
	defer rows.Close()
	var out []ChangeFeedback
	for rows.Next() {
		var f ChangeFeedback
		if err := rows.Scan(&f.Summary, &f.Feedback); err != nil {
			return nil, fmt.Errorf("scan change feedback: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func listChanges(ctx context.Context, q querier, sql string, args ...any) ([]ChangeRow, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list changes: %w", err)
	}
	defer rows.Close()
	var out []ChangeRow
	for rows.Next() {
		c, err := scanChange(rows)
		if err != nil {
			return nil, fmt.Errorf("scan change: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (t pgxTx) InsertChange(ctx context.Context, c ChangeRow) error {
	dims := c.Dimensions
	if dims == nil {
		dims = []string{}
	}
	suppressed := c.SuppressedBy
	if suppressed == nil {
		suppressed = []string{}
	}
	magnitude := c.Magnitude
	if len(magnitude) == 0 {
		magnitude = json.RawMessage(`{}`)
	}
	var agent any
	if len(c.Agent) > 0 {
		agent = []byte(c.Agent)
	}
	_, err := t.tx.Exec(ctx, `
		INSERT INTO changes (id, monitor_id, user_id, run_id, from_run_id, status,
		                     dimensions, suppressed_by, magnitude, summary, item_count, agent,
		                     record_key, diff_image_key, crop_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7::change_dimension[], $8, $9, $10, $11, $12, $13, $14, $15)
	`, c.ID, c.MonitorID, c.UserID, c.RunID, c.FromRunID, string(c.Status),
		dims, suppressed, []byte(magnitude), c.Summary, c.ItemCount, agent,
		c.RecordKey, c.DiffImageKey, c.CropKey)
	if err != nil {
		return fmt.Errorf("insert change for run %s: %w", c.RunID, err)
	}
	return nil
}

func (s *PgxStore) MarkNotified(ctx context.Context, changeID string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE changes SET notified_at = $2 WHERE id = $1`, changeID, at)
	return err
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

// monitorTxIdleTimeout is how long the Monitor's transaction may sit idle. The
// pipeline calls the agent while it holds the transaction (a Watch Plan and
// a comparison, each bounded at 150 s), so a server-wide
// idle_in_transaction_session_timeout tuned for short transactions would kill
// it mid-evaluation. This bound still frees the lock if the scheduler hangs.
const monitorTxIdleTimeout = "10min"

// WithMonitorLock runs fn inside a transaction that holds
// pg_advisory_xact_lock(hashtext(monitor_id)). The lock is released on commit
// or rollback.
func (s *PgxStore) WithMonitorLock(ctx context.Context, monitorID string, fn func(Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SET LOCAL idle_in_transaction_session_timeout = '`+monitorTxIdleTimeout+`'`); err != nil {
		return fmt.Errorf("set transaction idle timeout: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, monitorID); err != nil {
		return fmt.Errorf("lock monitor %s: %w", monitorID, err)
	}
	if err := fn(pgxTx{tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

func (t pgxTx) InsertDigestItem(ctx context.Context, cfg monitor.Config, changeID, bucket string) error {
	_, err := t.tx.Exec(ctx, `
		INSERT INTO digest_items (change_id, monitor_id, user_id, bucket)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (change_id) DO NOTHING
	`, changeID, cfg.ID, cfg.UserID, bucket)
	if err != nil {
		return fmt.Errorf("insert digest item: %w", err)
	}
	return nil
}

func (s *PgxStore) UnsentDigestItems(ctx context.Context, bucket string) ([]DigestRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.change_id, d.monitor_id, m.name, d.user_id, COALESCE(c.summary, ''), c.created_at
		FROM digest_items d
		JOIN changes c ON c.id = d.change_id
		JOIN monitors m ON m.id = d.monitor_id
		WHERE d.bucket = $1 AND d.sent_at IS NULL
		ORDER BY d.user_id, m.name, c.created_at
	`, bucket)
	if err != nil {
		return nil, fmt.Errorf("unsent digest items: %w", err)
	}
	defer rows.Close()
	var out []DigestRow
	for rows.Next() {
		var d DigestRow
		if err := rows.Scan(&d.ChangeID, &d.MonitorID, &d.MonitorName, &d.UserID, &d.Summary, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *PgxStore) MarkDigestSent(ctx context.Context, changeIDs []string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE digest_items SET sent_at = $2 WHERE change_id = ANY($1::uuid[])`, changeIDs, at)
	if err != nil {
		return fmt.Errorf("mark digest sent: %w", err)
	}
	_, err = s.pool.Exec(ctx, `UPDATE changes SET notified_at = $2 WHERE id = ANY($1::uuid[]) AND notified_at IS NULL`, changeIDs, at)
	return err
}

// ---------------------------------------------------------------------------
// Notification configs
// ---------------------------------------------------------------------------

func (s *PgxStore) GetNotificationConfigs(ctx context.Context, userID string) ([]NotificationConfig, error) {
	const query = `
		SELECT id, user_id, channel_id, name, credentials, enabled
		FROM notification_config
		WHERE enabled = true AND user_id = $1
	`
	rows, err := s.pool.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("fetch notification_configs: %w", err)
	}
	defer rows.Close()

	var out []NotificationConfig
	for rows.Next() {
		var n NotificationConfig
		if err := rows.Scan(&n.ID, &n.UserID, &n.ChannelID, &n.Name, &n.Credentials, &n.Enabled); err != nil {
			return nil, fmt.Errorf("scan notification_config: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// RetentionCandidates returns Captures older than before whose objects are
// still stored and that no change row or baseline references.
func (s *PgxStore) RetentionCandidates(ctx context.Context, before time.Time, limit int) ([]RetentionCandidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.run_id, c.blocks_key, c.screenshot_key
		FROM captures c
		WHERE c.created_at < $1
		  AND (c.blocks_key IS NOT NULL OR c.screenshot_key IS NOT NULL)
		  AND NOT EXISTS (SELECT 1 FROM changes ch WHERE ch.run_id = c.run_id OR ch.from_run_id = c.run_id)
		  AND NOT EXISTS (
		      SELECT 1 FROM monitor_state st
		      WHERE st.previous_run_id = c.run_id OR st.last_notified_run_id = c.run_id
		  )
		ORDER BY c.created_at
		LIMIT $2
	`, before, limit)
	if err != nil {
		return nil, fmt.Errorf("retention candidates: %w", err)
	}
	defer rows.Close()
	var out []RetentionCandidate
	for rows.Next() {
		var runID string
		var blocks, shot *string
		if err := rows.Scan(&runID, &blocks, &shot); err != nil {
			return nil, err
		}
		cand := RetentionCandidate{RunID: runID}
		for _, k := range []*string{blocks, shot} {
			if k != nil && *k != "" {
				cand.Keys = append(cand.Keys, *k)
			}
		}
		out = append(out, cand)
	}
	return out, rows.Err()
}

func (s *PgxStore) ClearCaptureKeys(ctx context.Context, runIDs []string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE captures SET blocks_key = NULL, screenshot_key = NULL
		WHERE run_id = ANY($1::uuid[])
	`, runIDs)
	return err
}

func (s *PgxStore) ExpiredChanges(ctx context.Context, before time.Time, limit int) ([]ChangeRow, error) {
	return listChanges(ctx, s.pool, `SELECT `+changeColumns+` FROM changes WHERE created_at < $1 ORDER BY created_at LIMIT $2`, before, limit)
}

func (s *PgxStore) DeleteChanges(ctx context.Context, ids []string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM changes WHERE id = ANY($1::uuid[])`, ids)
	return err
}

// ExpiredStepScreenshots returns the screenshots of Run steps recorded before
// `before`. Steps of a Macro recording (macro_id set) are left alone: they
// belong to the Macro, not to a Run.
func (s *PgxStore) ExpiredStepScreenshots(ctx context.Context, before time.Time, limit int) ([]StepScreenshot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, screenshot_key
		FROM run_steps
		WHERE run_id IS NOT NULL AND screenshot_key IS NOT NULL AND created_at < $1
		ORDER BY created_at
		LIMIT $2
	`, before, limit)
	if err != nil {
		return nil, fmt.Errorf("expired step screenshots: %w", err)
	}
	defer rows.Close()
	var out []StepScreenshot
	for rows.Next() {
		var st StepScreenshot
		if err := rows.Scan(&st.StepID, &st.Key); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func (s *PgxStore) ClearStepScreenshots(ctx context.Context, stepIDs []string) error {
	_, err := s.pool.Exec(ctx, `UPDATE run_steps SET screenshot_key = NULL WHERE id = ANY($1::uuid[])`, stepIDs)
	return err
}
