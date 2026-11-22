package pipeline

import (
	"bytes"
	"context"
	"errors"
	"strings"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/agentclient"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
)

// ask sends a difference to the agent and returns its answer. It never
// fails: when the agent cannot be asked (no model connection, the agent API
// is down, the model call failed) the answer is "unavailable", which the
// verdict treats as relevant, so the product keeps working without a model.
func (e *evaluation) ask(ctx context.Context, step diff.Evidence, base, cur *side) answer {
	if e.p.agent == nil {
		return e.unavailable("The agent API is not configured.")
	}
	if e.cfg.ConnectionID == nil {
		return e.unavailable("This Monitor has no model connection.")
	}

	req := agentclient.CompareRequest{
		RunID:        e.run.ID,
		MonitorID:    e.cfg.ID,
		UserID:       e.cfg.UserID,
		Monitor:      e.monitorInfo(),
		ConnectionID: e.cfg.ConnectionID,
		Model:        e.cfg.Model,
		From:         e.p.runRef(base),
		To:           e.p.runRef(cur),
		Plan:         e.cfg.WatchPlan,
		Regions:      []agentclient.Region{},
		Feedback:     []agentclient.Feedback{},
	}

	// Differences in parts of the page the plan does not watch as text never
	// reach the model. The ops that do are renumbered for the request; sent
	// maps each of them back to its place in the full list, which is what
	// the Change Record keeps.
	var sent []int
	if step.Text != nil {
		section := changerecord.TextSectionOf(step.Text)
		counted := make([]diff.TextOp, 0, len(section.Ops))
		for i, op := range section.Ops {
			if op.Counted() {
				counted = append(counted, op)
				sent = append(sent, i)
			}
		}
		section.Ops = counted
		req.Text = section
	}
	if v := step.Visual; v != nil {
		req.SizeBefore, req.SizeAfter = v.SizeBefore, v.SizeAfter
		for _, r := range v.Regions {
			req.Regions = append(req.Regions, agentclient.Region{Box: r.Box, FromBox: r.FromBox, Kind: r.Kind, Pixels: r.Pixels, Section: r.Section})
		}
	}

	feedback, err := e.tx.RecentChangeFeedback(ctx, e.cfg.ID, feedbackLimit)
	if err != nil {
		// What the owner thought of earlier Changes helps the agent, but a
		// comparison without it is still a comparison.
		e.p.log.Warn("failed to load change feedback", "monitor_id", e.cfg.ID, "err", err)
	}
	for _, f := range feedback {
		req.Feedback = append(req.Feedback, agentclient.Feedback{Summary: f.Summary, Feedback: f.Feedback})
	}

	resp, err := e.p.agent.Compare(ctx, req)
	if err != nil {
		e.p.log.Warn("agent comparison failed; sending the difference as it is",
			"monitor_id", e.cfg.ID, "run_id", e.run.ID, "code", agentclient.Code(err), "err", err)
		return e.unavailable(agentclient.Reason(err))
	}
	e.spend(resp.InputTokens, resp.OutputTokens)

	a := answer{
		summary: oneLine(resp.Summary),
		ignored: resp.Ignored,
		verdict: changerecord.AgentVerdict{
			Relevant:     resp.Relevant,
			Importance:   importance(resp.Importance),
			Model:        resp.Model,
			InputTokens:  resp.InputTokens,
			OutputTokens: resp.OutputTokens,
			Steps:        resp.Steps,
		},
	}
	for _, it := range resp.Items {
		ops := make([]int, 0, len(it.Ops))
		for _, i := range it.Ops {
			// An index the request did not have stays invalid, for the
			// evidence guard to strip.
			if i >= 0 && i < len(sent) {
				ops = append(ops, sent[i])
			} else {
				ops = append(ops, -1)
			}
		}
		a.items = append(a.items, changerecord.Item{
			Title: oneLine(it.Title), Before: strings.TrimSpace(it.Before), After: strings.TrimSpace(it.After),
			Kind: it.Kind, Matches: oneLine(it.Matches), Ops: ops, Regions: it.Regions,
		})
	}
	return a
}

// unavailable is the answer when the agent could not be asked.
func (e *evaluation) unavailable(reason string) answer {
	v := changerecord.AgentVerdict{Relevant: true, Importance: changerecord.ImportanceMedium, Unavailable: true, Error: reason}
	if e.cfg.Model != nil {
		v.Model = *e.cfg.Model
	}
	return answer{verdict: v}
}

func (e *evaluation) monitorInfo() agentclient.MonitorInfo {
	return agentclient.MonitorInfo{Name: e.cfg.Name, URL: e.cfg.URL, Instructions: e.cfg.EffectiveInstructions()}
}

// reuse returns the agent's answer of the pending Change when this confirm
// Run finds the page in the state the pending Change saw: the same watched
// text, and no visual difference between the two Captures. The model already
// judged exactly this, so it is not asked (or paid) again.
//
// It reports false when there is no pending Change, the page moved on, or
// the earlier answer cannot stand in: the agent was unavailable then, so it
// deserves a second try now.
func (e *evaluation) reuse(ctx context.Context, pending *pendingChange, cur *side) (answer, bool) {
	if pending == nil || pending.row.RecordKey == nil {
		return answer{}, false
	}
	seen, err := e.loadSide(ctx, pending.row.RunID)
	if err != nil {
		return answer{}, false
	}
	if len(cur.textHash) == 0 || !bytes.Equal(seen.textHash, cur.textHash) {
		return answer{}, false
	}
	if !e.sameLooks(ctx, seen, cur) {
		return answer{}, false
	}

	var rec changerecord.Record
	if err := objects.GetJSONGzip(ctx, e.p.objects, *pending.row.RecordKey, &rec); err != nil {
		if !errors.Is(err, objects.ErrNotFound) {
			e.p.log.Warn("failed to load the pending Change Record", "change_id", pending.row.ID, "err", err)
		}
		return answer{}, false
	}
	if rec.Agent == nil || rec.Agent.Unavailable || !rec.Agent.Relevant {
		return answer{}, false
	}

	// The usage belongs to the Run that made the call, not to this one.
	verdict := *rec.Agent
	verdict.InputTokens, verdict.OutputTokens, verdict.Steps = 0, 0, 0
	// The items cite the pending record's evidence by index. This Run's
	// evidence compares the same two states, and the evidence guard strips
	// whatever does not line up after all.
	return answer{summary: rec.Summary, items: rec.Items, ignored: rec.Ignored, verdict: verdict}, true
}

// sameLooks reports whether two Captures show no visual difference where the
// Monitor watches for one. Two Captures without screenshots look the same;
// one missing screenshot cannot be vouched for.
func (e *evaluation) sameLooks(ctx context.Context, a, b *side) bool {
	if a.row.ScreenshotKey == nil && b.row.ScreenshotKey == nil {
		return true
	}
	ev := e.p.compareVisual(ctx, e.cfg, a, b)
	return ev != nil && len(ev.Regions) == 0
}

func importance(s string) string {
	switch s {
	case changerecord.ImportanceHigh, changerecord.ImportanceMedium, changerecord.ImportanceLow:
		return s
	}
	return changerecord.ImportanceMedium
}

// oneLine folds every whitespace run into one space.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
