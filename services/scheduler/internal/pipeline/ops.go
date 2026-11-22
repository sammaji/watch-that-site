package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/render"
)

// ErrBadRequest marks an operation rejected because of its input.
var ErrBadRequest = errors.New("pipeline: bad request")

// ErrAgent marks an operation that failed because the agent could not
// answer.
var ErrAgent = errors.New("pipeline: agent failed")

// Compare builds a transient Change Record between any two Captures of one
// Monitor ("Compare…" in the Change view). Both are read under the Monitor's
// current Watch Plan. The agent is not asked and nothing is stored: the
// record holds the evidence and a summary built from it.
func (p *Pipeline) Compare(ctx context.Context, fromRun, toRun string) (changerecord.Record, error) {
	fromRow, err := p.store.GetCapture(ctx, fromRun)
	if err != nil {
		return changerecord.Record{}, err
	}
	toRow, err := p.store.GetCapture(ctx, toRun)
	if err != nil {
		return changerecord.Record{}, err
	}
	if fromRow.MonitorID != toRow.MonitorID {
		return changerecord.Record{}, fmt.Errorf("%w: the two Runs belong to different Monitors", ErrBadRequest)
	}
	cfg, err := p.store.GetMonitor(ctx, fromRow.MonitorID)
	if err != nil {
		return changerecord.Record{}, err
	}
	from, err := p.loadSide(ctx, p.store, cfg, fromRun)
	if err != nil {
		return changerecord.Record{}, err
	}
	to, err := p.loadSide(ctx, p.store, cfg, toRun)
	if err != nil {
		return changerecord.Record{}, err
	}

	step := p.compare(ctx, cfg, from, to)
	// No verdict was reached here, so the status only says whether the two
	// Captures differ where the Monitor watches.
	verdict := decide.Verdict{Status: decide.StatusNoise, Why: []decide.Why{{
		Kind: decide.WhyNote, Detail: "These two Captures show no difference where this Monitor watches.",
	}}}
	if decide.NeedsAgent(step) {
		verdict = decide.Verdict{Status: decide.StatusChange, Why: []decide.Why{{
			Kind: decide.WhyNote, Detail: "Compared on request. The agent was not asked about this difference.",
		}}}
	}
	rec := changerecord.Build(changerecord.BuildInput{
		Monitor: cfg,
		From:    p.runRef(from),
		To:      p.runRef(to),
		Verdict: verdict,
		Step:    step,
		Now:     p.now(),
	})
	rec.Summary = summaryNone
	if decide.NeedsAgent(step) {
		rec.Summary = render.TemplateSummary(rec)
	}
	return rec, nil
}

// screenshotSize reads the screenshot size out of captures.meta, or zero.
func screenshotSize(meta json.RawMessage) [2]int {
	var m captureMeta
	if json.Unmarshal(meta, &m) != nil || m.Screenshot == nil {
		return [2]int{}
	}
	return [2]int{m.Screenshot.W, m.Screenshot.H}
}

// AcceptBaseline makes a Run's Capture both baselines of its Monitor
// ("Accept as baseline"), and drops any pending Change.
func (p *Pipeline) AcceptBaseline(ctx context.Context, monitorID, runID string) error {
	return p.store.WithMonitorLock(ctx, monitorID, func(tx db.Tx) error {
		row, err := tx.GetCapture(ctx, runID)
		if err != nil {
			if errors.Is(err, db.ErrNotFound) {
				return fmt.Errorf("%w: run %s has no Capture", ErrBadRequest, runID)
			}
			return err
		}
		if row.MonitorID != monitorID {
			return fmt.Errorf("%w: run %s belongs to another Monitor", ErrBadRequest, runID)
		}
		cfg, err := tx.GetMonitor(ctx, monitorID)
		if err != nil {
			return err
		}
		state, _, err := tx.GetState(ctx, monitorID)
		if err != nil {
			return err
		}
		state.PreviousRunID = &runID
		state.LastNotifiedRunID = &runID
		state.PendingChangeID = nil
		// Keep the recorded versions: the accepted Capture was taken under
		// them, so the next Run compares normally instead of re-baselining.
		if state.EnvVersion == nil {
			env := p.envVersion
			state.EnvVersion = &env
		}
		if state.CaptureVersion == nil {
			cv := cfg.CaptureVersion()
			state.CaptureVersion = &cv
		}
		return tx.SaveState(ctx, cfg, state)
	})
}

// DigestResult reports one digest run.
type DigestResult struct {
	Owners  int `json:"owners"`
	Changes int `json:"changes"`
	Failed  int `json:"failed"`
}

// RunDigests sends one digest per owner for every unsent item in the bucket.
func (p *Pipeline) RunDigests(ctx context.Context, bucket string) (DigestResult, error) {
	if bucket != monitor.UrgencyHourly && bucket != monitor.UrgencyDaily {
		return DigestResult{}, fmt.Errorf("%w: bucket must be hourly or daily", ErrBadRequest)
	}
	rows, err := p.store.UnsentDigestItems(ctx, bucket)
	if err != nil {
		return DigestResult{}, err
	}
	return p.sendDigests(ctx, bucket, rows)
}

// sendDigests groups digest items per owner, sends each owner one digest
// listing every Change's summary, and stamps the items sent.
func (p *Pipeline) sendDigests(ctx context.Context, bucket string, rows []db.DigestRow) (DigestResult, error) {
	var order []string
	groups := map[string][]db.DigestRow{}
	for _, r := range rows {
		if _, ok := groups[r.UserID]; !ok {
			order = append(order, r.UserID)
		}
		groups[r.UserID] = append(groups[r.UserID], r)
	}

	var res DigestResult
	for _, userID := range order {
		items := groups[userID]
		entries := make([]render.DigestEntry, 0, len(items))
		ids := make([]string, 0, len(items))
		for _, it := range items {
			entries = append(entries, render.DigestEntry{
				ChangeID: it.ChangeID, MonitorID: it.MonitorID, MonitorName: it.MonitorName,
				Summary: it.Summary, At: it.CreatedAt,
			})
			ids = append(ids, it.ChangeID)
		}
		payload, err := render.DigestNotification(entries, bucket, p.links("", ""))
		if err != nil {
			return res, err
		}
		if p.notifier != nil {
			if err := p.notifier.Send(ctx, userID, payload); err != nil {
				p.log.Error("failed to send digest", "user_id", userID, "err", err)
				res.Failed++
				continue
			}
		}
		if err := p.store.MarkDigestSent(ctx, ids, p.now().UTC()); err != nil {
			return res, err
		}
		res.Owners++
		res.Changes += len(ids)
	}
	return res, nil
}

// Objects exposes the object store, for the retention job.
func (p *Pipeline) Objects() objects.Store { return p.objects }
