// Package db is the scheduler's data-access layer: the Store contract for every
// database interaction plus its Postgres implementation and a LISTEN/NOTIFY
// helper.
package db

import (
	"context"
	"errors"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("db: not found")

// Store is the contract for every database interaction the scheduler performs.
// Callers depend on this interface, not the concrete Postgres implementation.
type Store interface {
	// ScheduleDueRuns inserts a processing Run for every active Monitor due at
	// epochMinutes, promotes confirm Runs whose time has come, and returns
	// the scrape jobs to publish. All within one transaction.
	ScheduleDueRuns(ctx context.Context, epochMinutes int, now time.Time, envVersion string) ([]ScrapeJob, error)

	// CreateRun inserts a processing Run of the given trigger for one Monitor
	// and returns its scrape job. For trigger confirm, an existing pending
	// confirm Run is promoted instead of creating a new one.
	CreateRun(ctx context.Context, monitorID, trigger, envVersion string) (ScrapeJob, error)

	// MarkRunFailed transitions a Run to failed outside the pipeline, e.g.
	// when its scrape job could not be published.
	MarkRunFailed(ctx context.Context, runID string, runErr RunError) error

	// FailStaleRuns marks Runs still processing since before `before` as
	// failed with code "timeout" and returns how many it failed. A Run whose
	// Capture never comes back (the browser worker died, the message was
	// lost) would otherwise stay processing forever.
	FailStaleRuns(ctx context.Context, before time.Time) (int64, error)

	// GetRun loads one Run.
	GetRun(ctx context.Context, runID string) (Run, error)

	// AddRunTokens adds model usage to a Run that is already finished: a
	// Watch Plan made on demand from its Capture.
	AddRunTokens(ctx context.Context, runID string, input, output int) error

	// GetMonitor loads one Monitor's pipeline configuration.
	GetMonitor(ctx context.Context, monitorID string) (monitor.Config, error)

	// SaveWatchPlan stores a Monitor's Watch Plan.
	SaveWatchPlan(ctx context.Context, monitorID string, plan monitor.WatchPlan) error

	// GetState loads a Monitor's state; ok is false when it has none yet.
	GetState(ctx context.Context, monitorID string) (State, bool, error)

	// GetCapture loads one captures row.
	GetCapture(ctx context.Context, runID string) (CaptureRow, error)

	// GetChangeByRun returns the change recorded for a Run, if any.
	GetChangeByRun(ctx context.Context, runID string) (*ChangeRow, error)

	// MarkNotified stamps notified_at on a change.
	MarkNotified(ctx context.Context, changeID string, at time.Time) error

	// WithMonitorLock runs fn in a transaction holding the Monitor's advisory
	// lock, so two Runs of one Monitor are evaluated one after the other.
	WithMonitorLock(ctx context.Context, monitorID string, fn func(Tx) error) error

	// UnsentDigestItems returns the digest items of a bucket not yet sent.
	UnsentDigestItems(ctx context.Context, bucket string) ([]DigestRow, error)

	// MarkDigestSent stamps sent_at on the given changes' digest items.
	MarkDigestSent(ctx context.Context, changeIDs []string, at time.Time) error

	// GetNotificationConfigs loads all enabled notification configs of a user.
	GetNotificationConfigs(ctx context.Context, userID string) ([]NotificationConfig, error)

	// Retention queries.
	RetentionCandidates(ctx context.Context, before time.Time, limit int) ([]RetentionCandidate, error)
	ClearCaptureKeys(ctx context.Context, runIDs []string) error
	ExpiredChanges(ctx context.Context, before time.Time, limit int) ([]ChangeRow, error)
	DeleteChanges(ctx context.Context, ids []string) error
	// ExpiredStepScreenshots returns the screenshots of Run steps recorded
	// before `before`; ClearStepScreenshots forgets their keys once the
	// objects are gone.
	ExpiredStepScreenshots(ctx context.Context, before time.Time, limit int) ([]StepScreenshot, error)
	ClearStepScreenshots(ctx context.Context, stepIDs []string) error
}

// Tx is the set of reads and writes the pipeline performs inside a Monitor's
// lock.
type Tx interface {
	GetRun(ctx context.Context, runID string) (Run, error)
	GetMonitor(ctx context.Context, monitorID string) (monitor.Config, error)
	SaveWatchPlan(ctx context.Context, monitorID string, plan monitor.WatchPlan) error
	GetState(ctx context.Context, monitorID string) (State, bool, error)
	SaveState(ctx context.Context, cfg monitor.Config, s State) error
	GetCapture(ctx context.Context, runID string) (CaptureRow, error)
	InsertCapture(ctx context.Context, c CaptureRow) error
	GetChange(ctx context.Context, id string) (ChangeRow, error)
	InsertChange(ctx context.Context, c ChangeRow) error
	MarkRunSucceeded(ctx context.Context, runID, verdict string, outcome RunOutcome) error
	MarkRunFailed(ctx context.Context, runID string, runErr RunError, invalidReason *string, outcome RunOutcome) error
	InsertRun(ctx context.Context, cfg monitor.Config, trigger string, status string, scheduledFor *time.Time) (Run, error)
	InsertDigestItem(ctx context.Context, cfg monitor.Config, changeID, bucket string) error
	// RecentChangeFeedback returns the owner's feedback on the Monitor's
	// most recent Changes that have any, newest first.
	RecentChangeFeedback(ctx context.Context, monitorID string, limit int) ([]ChangeFeedback, error)
}
