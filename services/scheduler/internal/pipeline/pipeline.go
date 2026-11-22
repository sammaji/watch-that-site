// Package pipeline evaluates one Capture end to end: validate it, store it,
// compare it with the baseline, ask the agent whether a difference is a
// Change the owner asked about, and record the verdict, all inside the
// Monitor's advisory lock. Reactions are dispatched after the transaction
// commits.
//
// The AMQP consumer (artifact_worker) and the admin API (admin) both drive it.
package pipeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/agentclient"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/broker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
)

// DefaultEnvVersion identifies the capture environment (browser build,
// locale, timezone, stabilization). Bump it whenever that environment
// changes: every Monitor then re-baselines silently instead of alerting on a
// platform upgrade. ENV_VERSION overrides it.
const DefaultEnvVersion = "2026-11-21.1"

const (
	// blockCacheSize is how many Captures' blocks stay in memory.
	blockCacheSize = 64
	// failureAlertAfter is how many consecutive failed Runs raise the one
	// "this Monitor keeps failing" notification.
	failureAlertAfter = 3
	// planStaleAfter is how many consecutive Runs a Watch Plan may be missing
	// or out of step with the page before a new one is asked for.
	planStaleAfter = 3
	// feedbackLimit is how many of the owner's verdicts on earlier Changes
	// the agent is shown.
	feedbackLimit = 5
	// signedImageTTL is how long image links in notifications stay valid.
	signedImageTTL = 7 * 24 * time.Hour
	// confirmDelayCap bounds the wait before a confirm Run.
	confirmDelayCap = 5 * time.Minute
	// partialMinBaseline and partialRatio implement the partial-load check:
	// a Capture under 10 % of a baseline longer than 500 characters is
	// treated as a failed load.
	partialMinBaseline = 500
	partialRatio       = 0.10
)

// Agent is the agent API: it judges differences and plans how a page is
// watched. Satisfied by *agentclient.Client; tests use a fake.
type Agent interface {
	Compare(ctx context.Context, req agentclient.CompareRequest) (agentclient.CompareResponse, error)
	Plan(ctx context.Context, req agentclient.PlanRequest) (agentclient.PlanResponse, error)
}

// Notifier fans a payload out to a user's configured Channels. Satisfied by
// *notify.Notifier.
type Notifier interface {
	Send(ctx context.Context, userID string, payload notify.NotificationPayload) error
}

// Options configures a Pipeline.
type Options struct {
	Store   db.Store
	Objects objects.Store
	// Agent may be nil: every difference is then sent as it is, and no Watch
	// Plan is ever made.
	Agent     Agent
	Notifier  Notifier
	Publisher broker.Publisher
	// JobRoutingKey is where confirm Runs are published.
	JobRoutingKey string
	EnvVersion    string
	WebURL        string
	Now           func() time.Time
	Logger        *slog.Logger
}

// Pipeline evaluates Captures.
type Pipeline struct {
	store         db.Store
	objects       objects.Store
	agent         Agent
	notifier      Notifier
	publisher     broker.Publisher
	jobRoutingKey string
	envVersion    string
	webURL        string
	now           func() time.Time
	log           *slog.Logger
	blocks        *objects.LRU[capture.StoredBlocks]
}

// New builds a Pipeline.
func New(opts Options) *Pipeline {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	env := opts.EnvVersion
	if env == "" {
		env = DefaultEnvVersion
	}
	return &Pipeline{
		store:         opts.Store,
		objects:       opts.Objects,
		agent:         opts.Agent,
		notifier:      opts.Notifier,
		publisher:     opts.Publisher,
		jobRoutingKey: opts.JobRoutingKey,
		envVersion:    env,
		webURL:        opts.WebURL,
		now:           now,
		log:           log,
		blocks:        objects.NewLRU[capture.StoredBlocks](blockCacheSize),
	}
}

// EnvVersion is the capture environment version sent with every job.
func (p *Pipeline) EnvVersion() string { return p.envVersion }

// Outcome reports what Process did, for logging and tests.
type Outcome struct {
	RunID     string
	MonitorID string
	// Verdict is baseline, none, noise, pending or change; empty when the Run
	// failed.
	Verdict       string
	ChangeID      string
	Failed        bool
	InvalidReason string
	// Duplicate is true when the Run had already been processed.
	Duplicate bool
	Notified  bool
	Digest    bool
	// Planned is true when a new Watch Plan was saved during the Run.
	Planned bool
}

// ErrPermanent marks a Capture that can never be processed; the consumer
// discards it instead of requeueing.
var ErrPermanent = errors.New("pipeline: permanent failure")

// Process evaluates one Capture. A returned error means the message should be
// retried, unless it wraps ErrPermanent.
func (p *Pipeline) Process(ctx context.Context, c capture.Capture) (Outcome, error) {
	out := Outcome{RunID: c.RunID, MonitorID: c.MonitorID}
	var post postCommit

	err := p.store.WithMonitorLock(ctx, c.MonitorID, func(tx db.Tx) error {
		run, err := tx.GetRun(ctx, c.RunID)
		if err != nil {
			if errors.Is(err, db.ErrNotFound) {
				return fmt.Errorf("%w: %w", ErrPermanent, err)
			}
			return err
		}
		if run.MonitorID != c.MonitorID {
			return fmt.Errorf("%w: run %s belongs to monitor %s, not %s", ErrPermanent, run.ID, run.MonitorID, c.MonitorID)
		}
		if run.Status == db.RunSucceeded || run.Status == db.RunFailed {
			out.Duplicate = true
			return nil
		}

		cfg, err := tx.GetMonitor(ctx, c.MonitorID)
		if err != nil {
			return err
		}
		state, _, err := tx.GetState(ctx, c.MonitorID)
		if err != nil {
			return err
		}

		e := &evaluation{p: p, tx: tx, cfg: cfg, state: state, run: run, cap: c, now: p.now().UTC(), out: &out, post: &post}
		// A Macro repair is model usage of this Run, whatever comes of it.
		if c.Macro != nil {
			e.spend(c.Macro.InputTokens, c.Macro.OutputTokens)
		}
		if !c.Valid() {
			return e.fail(ctx, c.Reason(), captureErrorMessage(c))
		}
		return e.evaluate(ctx)
	})
	if err != nil {
		return out, err
	}

	p.afterCommit(ctx, &out, post)
	return out, nil
}

// postCommit collects the Reactions to dispatch once the transaction is
// committed, so nothing is sent for work that was rolled back.
type postCommit struct {
	notify    *notify.NotificationPayload
	changeID  string
	userID    string
	publish   *db.ScrapeJob
	failPubID string
}

func (p *Pipeline) afterCommit(ctx context.Context, out *Outcome, post postCommit) {
	if post.publish != nil && p.publisher != nil {
		if err := p.publisher.Publish(ctx, p.jobRoutingKey, *post.publish); err != nil {
			p.log.Error("failed to publish confirm run", "run_id", post.publish.RunID, "err", err)
			if markErr := p.store.MarkRunFailed(ctx, post.publish.RunID, db.RunError{Code: "publish_failed", Message: err.Error()}); markErr != nil {
				p.log.Error("failed to mark confirm run failed", "run_id", post.publish.RunID, "err", markErr)
			}
		}
	}

	if post.notify != nil && p.notifier != nil {
		if err := p.notifier.Send(ctx, post.userID, *post.notify); err != nil {
			p.log.Error("failed to send notification", "monitor_id", out.MonitorID, "run_id", out.RunID, "err", err)
			return
		}
		out.Notified = true
		if post.changeID != "" {
			if err := p.store.MarkNotified(ctx, post.changeID, p.now().UTC()); err != nil {
				p.log.Warn("failed to stamp notified_at", "change_id", post.changeID, "err", err)
			}
		}
	}
}

// captureErrorMessage renders a human-readable reason for an invalid or
// failed Capture.
func captureErrorMessage(c capture.Capture) string {
	if c.Error != nil && c.Error.Message != "" {
		// The worker's own words say more than the reason alone: which Macro
		// step failed, what the browser reported.
		if c.Status == capture.StatusError || c.Reason() == capture.ReasonMacroFailed {
			return c.Error.Message
		}
	}
	return invalidMessage(c)
}

func invalidMessage(c capture.Capture) string {
	switch c.Reason() {
	case capture.ReasonHTTPStatus:
		return fmt.Sprintf("The page responded with HTTP %d.", c.Meta.HTTPStatus)
	case capture.ReasonChallenge:
		return "The site showed a bot challenge instead of the page."
	case capture.ReasonEmpty:
		return "The page had no text."
	case capture.ReasonBlankScreenshot:
		return "The page rendered blank."
	case capture.ReasonCrossDomain:
		return "The page redirected to a different site."
	case capture.ReasonMacroFailed:
		if m := c.Macro; m != nil && m.FailedStep != nil {
			return fmt.Sprintf("Step %d of pre-scraping failed and could not be repaired.", *m.FailedStep+1)
		}
		return "A step of pre-scraping failed and could not be repaired."
	default:
		return "The Capture could not be taken."
	}
}

// partialMessage is the failure message of the partial-load check.
const partialMessage = "The page loaded only partially."
