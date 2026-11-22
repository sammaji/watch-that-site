package db

import (
	"encoding/json"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
)

// Run triggers (monitor_runs.trigger).
const (
	TriggerSchedule = "schedule"
	TriggerManual   = "manual"
	TriggerConfirm  = "confirm"
)

// Run statuses (monitor_run_status).
const (
	RunPending    = "pending"
	RunProcessing = "processing"
	RunSucceeded  = "succeeded"
	RunFailed     = "failed"
)

// Run verdicts (monitor_runs.verdict). A succeeded Run's verdict is one of the
// decide statuses, or "baseline" when it only established a baseline.
const VerdictBaseline = "baseline"

// ScrapeJobVersion is the ScrapeJob schema version.
const ScrapeJobVersion = 3

// Viewport is the browser viewport in CSS pixels.
type Viewport struct {
	W int `json:"w"`
	H int `json:"h"`
}

// CaptureOptions tells the browser worker how to take the Capture.
type CaptureOptions struct {
	Screenshot         string `json:"screenshot"` // webp | png
	FullPage           bool   `json:"full_page"`
	MaxHeight          int    `json:"max_height"`
	ExtraWaitMS        int    `json:"extra_wait_ms"`
	BlockAds           bool   `json:"block_ads"`
	BlockCookieBanners bool   `json:"block_cookie_banners"`
}

// ScrapeJob is the AMQP message sent to the browser worker (ScrapeJob v3).
// Mirrors ScrapeJob in packages/types/src/protocol.ts.
type ScrapeJob struct {
	Version   int            `json:"version"`
	RunID     string         `json:"run_id"`
	MonitorID string         `json:"monitor_id"`
	URL       string         `json:"url"`
	Viewport  Viewport       `json:"viewport"`
	Capture   CaptureOptions `json:"capture"`
	// MacroID is the active Macro version to replay before the Capture, or
	// nil. The worker loads its steps from Postgres.
	MacroID         *string `json:"macro_id"`
	StorageStateKey *string `json:"storage_state_key"`
	EnvVersion      string  `json:"env_version"`
}

// Run is a monitor_runs row.
type Run struct {
	ID            string
	MonitorID     string
	UserID        string
	Status        string
	Trigger       string
	Verdict       *string
	InvalidReason *string
	Error         json.RawMessage
	// Summary is a few words on what the Run concluded, for the timeline.
	Summary *string
	// MacroID and MacroStatus say which Macro version was replayed and how
	// it went (ok, repaired, failed).
	MacroID     *string
	MacroStatus *string
	// InputTokens and OutputTokens are the model usage across the Run.
	InputTokens  int
	OutputTokens int
	ScheduledFor *time.Time
	CreatedAt    time.Time
}

// RunError is the JSON stored in monitor_runs.error.
type RunError struct {
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	OccurredAt time.Time `json:"occurred_at"`
}

// RunOutcome is what a finished Run records besides its status and verdict.
type RunOutcome struct {
	// Summary is shown on the Run timeline: "Baseline captured", "No
	// difference", the agent's sentence, the failure message.
	Summary string
	// MacroID and MacroStatus come from the Capture's Macro result; nil when
	// no Macro was replayed.
	MacroID     *string
	MacroStatus *string
	// InputTokens and OutputTokens add up every model call of the Run: a
	// Macro repair, a Watch Plan, the comparison.
	InputTokens  int
	OutputTokens int
}

// CaptureRow is a captures row.
type CaptureRow struct {
	RunID         string
	MonitorID     string
	UserID        string
	TextHash      []byte
	SimHash       uint64
	DHash         *uint64
	BlocksKey     *string
	ScreenshotKey *string
	Meta          json.RawMessage
	CreatedAt     time.Time
}

// ChangeRow is a changes row.
type ChangeRow struct {
	ID           string
	MonitorID    string
	UserID       string
	RunID        string
	FromRunID    string
	Status       decide.Status
	Dimensions   []string
	SuppressedBy []string
	Magnitude    json.RawMessage
	// Summary is the agent's one-sentence answer.
	Summary string
	// ItemCount is how many items the agent reported.
	ItemCount int
	// Agent is the Change Record's agent verdict as JSON, or empty.
	Agent        json.RawMessage
	RecordKey    *string
	DiffImageKey *string
	CropKey      *string
	UserFeedback *string
	ViewedAt     *time.Time
	NotifiedAt   *time.Time
	CreatedAt    time.Time
}

// ChangeFeedback is the owner's verdict on one earlier Change, which the
// agent reads to learn what this owner finds useful.
type ChangeFeedback struct {
	Summary  string
	Feedback string // useful | noise
}

// State is a monitor_state row: the Monitor's baselines.
type State struct {
	MonitorID string
	// PreviousRunID is the last valid Capture: every verdict is computed
	// against it.
	PreviousRunID *string
	// LastNotifiedRunID is the Capture at the last Change.
	LastNotifiedRunID   *string
	PendingChangeID     *string
	ConsecutiveFailures int
	// PlanStaleRuns counts consecutive Runs on which a watched Section of
	// the Watch Plan matched nothing on the page.
	PlanStaleRuns   int
	StorageStateKey *string
	EnvVersion      *string
	CaptureVersion  *string
}

// DigestRow is one unsent digest item joined with what the digest shows.
type DigestRow struct {
	ChangeID    string
	MonitorID   string
	MonitorName string
	UserID      string
	Summary     string
	CreatedAt   time.Time
}

// NotificationConfig mirrors the notification_config row used for fan-out.
// Credentials stays raw JSON; variant + targets are derived per channel.
type NotificationConfig struct {
	ID          string
	UserID      string
	ChannelID   string
	Name        string
	Credentials json.RawMessage
	Enabled     bool
}

// RetentionCandidate is a Capture whose objects retention may delete.
type RetentionCandidate struct {
	RunID string
	Keys  []string
}

// StepScreenshot is the screenshot of one run_steps row.
type StepScreenshot struct {
	StepID string
	Key    string
}
