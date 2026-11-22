package pipeline

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/agentclient"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

// errEmptyPlan is returned when the agent answered but none of its Sections
// fit the page.
var errEmptyPlan = errors.New("the agent's plan had no Section that matches the page")

// replan asks the agent for a new Watch Plan when the Monitor needs one, and
// reports whether e.cfg now carries a new plan. A plan is needed:
//
//   - when this Capture becomes the baseline;
//   - when the plan was made for other instructions than the Monitor has now;
//   - when the plan has not fitted the page for planStaleAfter Runs in a row
//     (a watched Section matches nothing), or there has been none for as long.
//
// Planning never fails the Run: without a model connection, or when the
// agent cannot answer, the Monitor keeps the plan it has (none means the
// whole page is watched).
func (e *evaluation) replan(ctx context.Context, cur *side, baseline bool) bool {
	if e.p.agent == nil || e.cfg.ConnectionID == nil {
		return false
	}
	plan := e.cfg.WatchPlan
	paths := blockPaths(cur.stored.Blocks)

	due := baseline
	switch {
	case baseline:
	case plan != nil && plan.InstructionsHash != monitor.InstructionsHash(e.cfg.Instructions):
		due = true
	case plan == nil || plan.Stale(paths):
		e.state.PlanStaleRuns++
		due = e.state.PlanStaleRuns >= planStaleAfter
	default:
		e.state.PlanStaleRuns = 0
	}
	if !due {
		return false
	}
	// Whatever comes of it, the count starts over: a plan that cannot be
	// made is tried again after another planStaleAfter Runs, not on each.
	e.state.PlanStaleRuns = 0

	ref := e.p.runRef(cur)
	var size [2]int
	if s := e.cap.Screenshot; s != nil {
		size = [2]int{s.W, s.H}
	}
	// How this page loaded, so the Agent can judge how long to wait.
	load := &agentclient.PlanLoad{
		LoadMS:        e.cap.Meta.TimingsMS.Load,
		SettleMS:      e.cap.Meta.TimingsMS.Settle,
		NetworkQuiet:  e.cap.Meta.NetworkQuiet,
		Stable:        e.cap.Meta.Stable,
		MovingRegions: len(e.cap.Masks),
		WaitMS:        e.cfg.ExtraWaitMS,
	}
	made, usage, err := e.p.makePlan(ctx, e.cfg, ref, size, load, paths, e.now)
	e.spend(usage.input, usage.output)
	if err != nil {
		e.p.log.Warn("watch plan not made; keeping the current one",
			"monitor_id", e.cfg.ID, "run_id", e.run.ID, "code", agentclient.Code(err), "err", err)
		return false
	}
	e.cfg.WatchPlan = made
	e.newPlan = made
	return true
}

type usage struct{ input, output int }

// makePlan asks the agent to plan from one Capture and checks the answer
// against that Capture's blocks. The usage is returned even when the plan is
// rejected: the model was called.
func (p *Pipeline) makePlan(ctx context.Context, cfg monitor.Config, ref changerecord.RunRef, size [2]int, load *agentclient.PlanLoad, paths []string, now time.Time) (*monitor.WatchPlan, usage, error) {
	resp, err := p.agent.Plan(ctx, agentclient.PlanRequest{
		RunID:        ref.RunID,
		MonitorID:    cfg.ID,
		UserID:       cfg.UserID,
		Monitor:      agentclient.MonitorInfo{Name: cfg.Name, URL: cfg.URL, Instructions: cfg.EffectiveInstructions()},
		ConnectionID: cfg.ConnectionID,
		Model:        cfg.Model,
		Capture:      ref,
		Size:         size,
		Load:         load,
		Previous:     cfg.WatchPlan,
	})
	if err != nil {
		return nil, usage{}, err
	}
	used := usage{resp.InputTokens, resp.OutputTokens}

	sections := monitor.GuardSections(resp.Sections, paths)
	if len(sections) == 0 {
		return nil, used, errEmptyPlan
	}
	rest := resp.Rest
	if !rest.Valid() {
		// Whatever the Sections leave out stays watched.
		rest = monitor.HowBoth
	}
	return &monitor.WatchPlan{
		Version:          monitor.WatchPlanVersion,
		Sections:         sections,
		Rest:             rest,
		Summary:          oneLine(resp.Summary),
		WaitMS:           min(max(resp.WaitMS, 0), 20000),
		InstructionsHash: monitor.InstructionsHash(cfg.Instructions),
		RunID:            ref.RunID,
		Model:            resp.Model,
		CreatedAt:        now.UTC().Truncate(time.Second),
	}, used, nil
}

// Replan makes a new Watch Plan from the Monitor's latest valid Capture and
// saves it ("Plan again" in the web app). The agent is called outside the
// Monitor's lock, so Runs are not held up while it thinks.
func (p *Pipeline) Replan(ctx context.Context, monitorID string) (monitor.WatchPlan, error) {
	cfg, err := p.store.GetMonitor(ctx, monitorID)
	if err != nil {
		return monitor.WatchPlan{}, err
	}
	if p.agent == nil || cfg.ConnectionID == nil {
		return monitor.WatchPlan{}, fmt.Errorf("%w: the Monitor has no model connection to plan with", ErrBadRequest)
	}
	state, _, err := p.store.GetState(ctx, monitorID)
	if err != nil {
		return monitor.WatchPlan{}, err
	}
	if state.PreviousRunID == nil {
		return monitor.WatchPlan{}, fmt.Errorf("%w: the Monitor has no Capture to plan from yet", ErrBadRequest)
	}
	row, err := p.store.GetCapture(ctx, *state.PreviousRunID)
	if err != nil {
		return monitor.WatchPlan{}, err
	}
	stored, err := p.storedBlocks(ctx, row)
	if err != nil {
		return monitor.WatchPlan{}, fmt.Errorf("%w: the Monitor's latest Capture has expired", ErrBadRequest)
	}
	s := &side{row: row, stored: stored}

	// A replan on request reads a stored Capture, which keeps no load timings.
	plan, used, err := p.makePlan(ctx, cfg, p.runRef(s), screenshotSize(row.Meta), nil, blockPaths(stored.Blocks), p.now())
	if used != (usage{}) {
		if tokErr := p.store.AddRunTokens(ctx, row.RunID, used.input, used.output); tokErr != nil {
			p.log.Warn("failed to record the plan's model usage", "run_id", row.RunID, "err", tokErr)
		}
	}
	if err != nil {
		return monitor.WatchPlan{}, fmt.Errorf("%w: %w", ErrAgent, err)
	}
	// Without the timings there is nothing to judge the wait by: keep it.
	plan.WaitMS = cfg.ExtraWaitMS
	if err := p.store.SaveWatchPlan(ctx, monitorID, *plan); err != nil {
		return monitor.WatchPlan{}, err
	}
	return *plan, nil
}

func blockPaths(blocks []capture.Block) []string {
	paths := make([]string, len(blocks))
	for i, b := range blocks {
		paths[i] = b.Path
	}
	return paths
}
