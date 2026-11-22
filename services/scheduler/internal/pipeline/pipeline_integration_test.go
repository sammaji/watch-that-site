package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/agentclient"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
)

var page = []string{"Acme pricing", "Starter plan $19/month", "Pro plan $49/month", "Updated 14:03"}

func withPrice(price string) []string {
	return []string{"Acme pricing", "Starter plan $19/month", "Pro plan " + price + "/month", "Updated 14:03"}
}

func TestIntegrationBaselineThenUnchanged(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")

	first := h.step(m, page...)
	require.Equal(t, db.VerdictBaseline, first.Verdict)
	second := h.step(m, page...)
	require.Equal(t, "none", second.Verdict)

	require.Zero(t, h.changeCount(m))
	require.Zero(t, h.notifier.count())
	require.Zero(t, h.agent.compareCount(), "identical Captures never reach the model")
	require.Equal(t, "Baseline captured", *h.getRun(first.RunID).Summary)
	require.Equal(t, "No difference", *h.getRun(second.RunID).Summary)
}

func TestIntegrationRelevantChangeNotifies(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	base := h.step(m, page...)

	out := h.step(m, withPrice("$59")...)
	require.Equal(t, "change", out.Verdict)
	require.NotEmpty(t, out.ChangeID)
	require.True(t, out.Notified)
	require.Equal(t, 1, h.notifier.count())
	require.Contains(t, h.notifier.last().Subject, "The agent says this matters.")

	// What the agent was asked.
	require.Equal(t, 1, h.agent.compareCount())
	req := h.agent.lastCompare()
	require.Equal(t, out.RunID, req.RunID)
	require.Equal(t, m, req.MonitorID)
	require.Equal(t, h.userID, req.UserID)
	require.Equal(t, monitor.DefaultInstructions, req.Monitor.Instructions, "no instructions: the default text")
	require.Equal(t, h.connID, *req.ConnectionID)
	require.Equal(t, "test-model", *req.Model)
	require.Equal(t, base.RunID, req.From.RunID)
	require.Equal(t, out.RunID, req.To.RunID)
	require.Equal(t, objects.BlocksKey(m, base.RunID), req.From.Blocks)
	require.Equal(t, objects.BlocksKey(m, out.RunID), req.To.Blocks)
	require.Len(t, req.Text.Ops, 1)
	require.Equal(t, diff.OpModify, req.Text.Ops[0].Op)
	require.Empty(t, req.Regions)
	require.Empty(t, req.Feedback)
	require.Nil(t, req.Plan)

	// The Change Record, version 2.
	rec := h.record(m, out.ChangeID)
	require.Equal(t, changerecord.Version, rec.Version)
	require.Equal(t, decide.StatusChange, rec.Status)
	require.Equal(t, "The agent says this matters.", rec.Summary)
	require.Equal(t, monitor.DefaultInstructions, rec.Monitor.Instructions)
	require.Len(t, rec.Items, 1)
	require.Equal(t, []int{0}, rec.Items[0].Ops)
	require.Equal(t, &geom.Rect{0, 60, 600, 24}, rec.Items[0].RectBefore, "filled from the cited op")
	require.Equal(t, &geom.Rect{0, 60, 600, 24}, rec.Items[0].RectAfter)
	require.Equal(t, []changerecord.Ignored{{Note: "the footer", Reason: "not asked about"}}, rec.Ignored)
	require.Equal(t, &changerecord.AgentVerdict{Relevant: true, Importance: "high", Model: "test-model", InputTokens: 1000, OutputTokens: 50, Steps: 2}, rec.Agent)
	require.Equal(t, decide.WhyAgent, rec.Why[0].Kind)
	require.Empty(t, rec.Sections)
	require.Nil(t, rec.Cumulative)

	// The changes row and the Run.
	row := h.change(out.ChangeID)
	require.Equal(t, "The agent says this matters.", row.Summary)
	require.Equal(t, 1, row.ItemCount)
	require.Equal(t, []string{"text"}, row.Dimensions)
	require.JSONEq(t, `{"relevant":true,"importance":"high","model":"test-model","unavailable":false,"error":"","input_tokens":1000,"output_tokens":50,"steps":2}`, string(row.Agent))
	run := h.getRun(out.RunID)
	require.Equal(t, "The agent says this matters.", *run.Summary)
	require.Equal(t, 1000, run.InputTokens)
	require.Equal(t, 50, run.OutputTokens)
	require.Nil(t, run.MacroID)
	require.Nil(t, run.MacroStatus)
}

func TestIntegrationNotRelevantIsNoise(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("Tell me about new plans only.")
	h.step(m, page...)

	h.agent.compare = notRelevant
	out := h.step(m, withPrice("$59")...)
	require.Equal(t, "noise", out.Verdict)
	require.Zero(t, h.notifier.count())
	require.Equal(t, "Tell me about new plans only.", h.agent.lastCompare().Monitor.Instructions)

	row := h.change(out.ChangeID)
	require.Equal(t, []string{decide.ReasonNotRelevant}, row.SuppressedBy)
	require.Equal(t, "Only the banner changed, which you did not ask about.", row.Summary)
	require.Zero(t, row.ItemCount)
	rec := h.record(m, out.ChangeID)
	require.False(t, rec.Agent.Relevant)
	require.Equal(t, decide.ReasonNotRelevant, rec.Why[0].Reason)
	run := h.getRun(out.RunID)
	require.Equal(t, "Only the banner changed, which you did not ask about.", *run.Summary)
	require.Equal(t, 800, run.InputTokens)

	// The Noise Run moved the baseline: the same page again is no difference.
	require.Equal(t, "none", h.step(m, withPrice("$59")...).Verdict)
	require.Equal(t, 1, h.agent.compareCount())
}

func TestIntegrationTimestampIsMaskedAway(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)

	later := append([]string{}, page...)
	later[3] = "Updated 14:05"
	require.Equal(t, "none", h.step(m, later...).Verdict)
	require.Zero(t, h.changeCount(m))
	require.Zero(t, h.agent.compareCount())
}

// The product keeps working without a model: when the agent cannot be asked,
// the difference is sent as it is.
func TestIntegrationAgentUnavailableFailsOpen(t *testing.T) {
	check := func(t *testing.T, h *harness, m string, wantError string, wantCalls int) {
		t.Helper()
		h.step(m, page...)
		out := h.step(m, withPrice("$59")...)
		require.Equal(t, "change", out.Verdict)
		require.True(t, out.Notified)
		require.Equal(t, wantCalls, h.agent.compareCount())

		rec := h.record(m, out.ChangeID)
		require.NotNil(t, rec.Agent)
		require.True(t, rec.Agent.Unavailable)
		require.Contains(t, rec.Agent.Error, wantError)
		require.Empty(t, rec.Items)
		require.Equal(t, "1 word added, 1 removed", rec.Summary, "built from the evidence")
		require.Len(t, rec.Why, 1)
		require.Equal(t, decide.WhyNote, rec.Why[0].Kind)
		require.Equal(t, decide.NoteAgentUnavailable, rec.Why[0].Reason)

		row := h.change(out.ChangeID)
		require.Zero(t, row.ItemCount)
		var agent changerecord.AgentVerdict
		require.NoError(t, json.Unmarshal(row.Agent, &agent))
		require.Equal(t, *rec.Agent, agent, "the changes row carries the record's agent verdict")
		require.Equal(t, "1 word added, 1 removed", *h.getRun(out.RunID).Summary)
		// The notification falls back to the diff.
		require.Contains(t, *h.notifier.last().Text, "- Pro plan $49/month")
		require.Contains(t, *h.notifier.last().Text, "+ Pro plan $59/month")
	}

	t.Run("the agent API is down", func(t *testing.T) {
		h := newHarness(t)
		h.agent.compare = agentDown
		check(t, h, h.monitor(""), "connection refused", 1)
	})
	t.Run("the agent API answers an error", func(t *testing.T) {
		h := newHarness(t)
		h.agent.compare = func(agentclient.CompareRequest) (agentclient.CompareResponse, error) {
			return agentclient.CompareResponse{}, &agentclient.Error{Status: 502, Code: "provider_error", Message: "the model provider said 401"}
		}
		check(t, h, h.monitor(""), "the model provider said 401", 1)
	})
	t.Run("the Monitor has no connection", func(t *testing.T) {
		h := newHarness(t)
		m := h.monitor("")
		h.exec(`UPDATE monitors SET connection_id = NULL WHERE id = $1`, m)
		check(t, h, m, "no model connection", 0)
		require.Zero(t, h.agent.planCount(), "nor is a plan asked for")
	})
	t.Run("no agent is configured", func(t *testing.T) {
		h := newHarness(t)
		h.agent = &fakeAgent{}
		h.p = New(Options{
			Store: h.store, Objects: h.objects, Notifier: h.notifier, EnvVersion: h.env, WebURL: "http://web.test",
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
		check(t, h, h.monitor(""), "not configured", 0)
	})
}

func TestIntegrationEvidenceGuard(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, "Headline", "Pro plan $49/month", "Team plan $99/month")

	h.agent.compare = func(req agentclient.CompareRequest) (agentclient.CompareResponse, error) {
		resp := relevantAnswer(req)
		resp.Items = []agentclient.CompareItem{
			{Title: "made up", Kind: "text", Ops: []int{7}, Regions: []int{3}},
			{Title: "cites nothing", Kind: "text"},
			{Title: "half right", Kind: "text", Ops: []int{1, 12, -4}, Regions: []int{0}},
		}
		return resp, nil
	}
	out := h.step(m, "Headline", "Pro plan $59/month", "Team plan $109/month")
	require.Equal(t, "change", out.Verdict)

	rec := h.record(m, out.ChangeID)
	require.Len(t, rec.Text.Ops, 2)
	require.Len(t, rec.Items, 1, "items without valid evidence are dropped")
	require.Equal(t, "half right", rec.Items[0].Title)
	require.Equal(t, []int{1}, rec.Items[0].Ops, "out-of-range indexes are stripped")
	require.Empty(t, rec.Items[0].Regions)
	require.Equal(t, &geom.Rect{0, 60, 600, 24}, rec.Items[0].RectAfter)
	require.Equal(t, 1, h.change(out.ChangeID).ItemCount)

	// Nothing the agent reported holds up: the Change stands on the diff.
	h.agent.compare = func(req agentclient.CompareRequest) (agentclient.CompareResponse, error) {
		resp := relevantAnswer(req)
		resp.Items = []agentclient.CompareItem{{Title: "made up", Kind: "text", Ops: []int{7}}}
		return resp, nil
	}
	out = h.step(m, "Headline", "Pro plan $69/month", "Team plan $109/month")
	require.Equal(t, "change", out.Verdict)
	rec = h.record(m, out.ChangeID)
	require.Empty(t, rec.Items)
	require.Equal(t, "1 word added, 1 removed", rec.Summary)
	require.Contains(t, rec.Why[len(rec.Why)-1].Detail, "did not point at anything in the diff")
}

func TestIntegrationOwnerFeedbackReachesTheAgent(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)

	prices := []string{"$50", "$51", "$52", "$53", "$54", "$55", "$56"}
	for i, price := range prices {
		out := h.step(m, withPrice(price)...)
		require.Equal(t, "change", out.Verdict)
		switch {
		case i == 0:
			// No feedback on the first one.
		case i%2 == 0:
			h.exec(`UPDATE changes SET user_feedback = 'useful', summary = $2 WHERE id = $1`, out.ChangeID, "useful "+price)
		default:
			h.exec(`UPDATE changes SET user_feedback = 'noise', summary = $2 WHERE id = $1`, out.ChangeID, "noise "+price)
		}
	}
	h.step(m, withPrice("$99")...)

	// The five most recent Changes with feedback, newest first.
	require.Equal(t, []agentclient.Feedback{
		{Summary: "useful $56", Feedback: "useful"},
		{Summary: "noise $55", Feedback: "noise"},
		{Summary: "useful $54", Feedback: "useful"},
		{Summary: "noise $53", Feedback: "noise"},
		{Summary: "useful $52", Feedback: "useful"},
	}, h.agent.lastCompare().Feedback)
}

func TestIntegrationConfirmRuns(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.exec(`UPDATE monitors SET confirm_changes = true WHERE id = $1`, m)
	h.step(m, "Headline A", "Body")

	// Seen once: recorded as pending, nobody is told yet.
	first := h.step(m, "Headline B", "Body")
	require.Equal(t, "pending", first.Verdict)
	require.Equal(t, 1, h.agent.compareCount())
	require.Zero(t, h.notifier.count())
	require.Equal(t, "Seen once, waiting for the next check to confirm", *h.getRun(first.RunID).Summary)
	require.Equal(t, "The agent says this matters.", h.change(first.ChangeID).Summary)
	require.Equal(t, first.ChangeID, *h.state(m).PendingChangeID)

	// The confirm Run finds the same page: the pending answer is reused.
	out := h.process(h.capture(m, h.confirmRun(m), "Headline B", "Body"))
	require.Equal(t, "change", out.Verdict)
	require.Equal(t, 1, h.agent.compareCount(), "the model is not asked twice about the same state")
	require.Equal(t, 1, h.notifier.count())
	require.Nil(t, h.state(m).PendingChangeID)
	rec := h.record(m, out.ChangeID)
	require.Equal(t, "The agent says this matters.", rec.Summary)
	require.Len(t, rec.Items, 1)
	require.Equal(t, []int{0}, rec.Items[0].Ops)
	require.True(t, rec.Agent.Relevant)
	require.Equal(t, "test-model", rec.Agent.Model)
	require.Zero(t, rec.Agent.InputTokens, "the usage stays with the Run that made the call")
	require.Equal(t, "Seen on two consecutive checks.", rec.Why[len(rec.Why)-1].Detail)
	run := h.getRun(out.RunID)
	require.Zero(t, run.InputTokens)
	require.Equal(t, "The agent says this matters.", *run.Summary)

	// A difference that is gone by the confirm Run is Noise.
	require.Equal(t, "pending", h.step(m, "Headline C", "Body").Verdict)
	require.Equal(t, 2, h.agent.compareCount())
	out = h.process(h.capture(m, h.confirmRun(m), "Headline B", "Body"))
	require.Equal(t, "noise", out.Verdict)
	require.Equal(t, []string{decide.ReasonDidNotPersist}, h.change(out.ChangeID).SuppressedBy)
	require.Equal(t, "The change was gone by the next check", *h.getRun(out.RunID).Summary)
	require.Equal(t, 2, h.agent.compareCount())
	require.Equal(t, 1, h.notifier.count())
	require.Nil(t, h.state(m).PendingChangeID)

	// The page moved on between the two Runs: the agent is asked again.
	require.Equal(t, "pending", h.step(m, "Headline D", "Body").Verdict)
	require.Equal(t, 3, h.agent.compareCount())
	out = h.process(h.capture(m, h.confirmRun(m), "Headline E", "Body"))
	require.Equal(t, "change", out.Verdict)
	require.Equal(t, 4, h.agent.compareCount())
	require.Equal(t, 2, h.notifier.count())
	require.Equal(t, 1000, h.getRun(out.RunID).InputTokens)

	// Asked again, the agent may also find it is not relevant after all.
	require.Equal(t, "pending", h.step(m, "Headline F", "Body").Verdict)
	h.agent.compare = notRelevant
	out = h.process(h.capture(m, h.confirmRun(m), "Headline G", "Body"))
	require.Equal(t, "noise", out.Verdict)
	require.Equal(t, []string{decide.ReasonNotRelevant}, h.change(out.ChangeID).SuppressedBy)
	require.Nil(t, h.state(m).PendingChangeID)
	require.Equal(t, 2, h.notifier.count())
}

// A pending Change the agent never reviewed is not waved through on the
// confirm Run: the agent gets its second chance.
func TestIntegrationConfirmRunAsksAgainAfterAnUnavailableAgent(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.exec(`UPDATE monitors SET confirm_changes = true WHERE id = $1`, m)
	h.step(m, "Headline A", "Body")

	h.agent.compare = agentDown
	require.Equal(t, "pending", h.step(m, "Headline B", "Body").Verdict)
	require.Zero(t, h.notifier.count())

	h.agent.compare = nil
	out := h.process(h.capture(m, h.confirmRun(m), "Headline B", "Body"))
	require.Equal(t, "change", out.Verdict)
	require.Equal(t, 2, h.agent.compareCount())
	require.False(t, h.record(m, out.ChangeID).Agent.Unavailable)
}

func TestIntegrationInvalidCaptureLeavesBaseline(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)
	before := h.state(m)

	out := h.failRun(m, capture.ReasonHTTPStatus)
	require.True(t, out.Failed)

	run := h.getRun(out.RunID)
	require.Equal(t, db.RunFailed, run.Status)
	require.Equal(t, capture.ReasonHTTPStatus, *run.InvalidReason)
	require.Equal(t, "The page responded with HTTP 503.", *run.Summary)

	after := h.state(m)
	require.Equal(t, before.PreviousRunID, after.PreviousRunID)
	require.Equal(t, 1, after.ConsecutiveFailures)
	require.Zero(t, h.changeCount(m))

	require.Equal(t, "none", h.step(m, page...).Verdict)
	require.Zero(t, h.state(m).ConsecutiveFailures)
}

func TestIntegrationPartialLoadFailsTheRun(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	long := make([]string, 30)
	for i := range long {
		long[i] = "A long paragraph of pricing details that fills the page nicely."
	}
	h.step(m, long...)

	out := h.step(m, "Loading…")
	require.True(t, out.Failed)
	require.Equal(t, capture.ReasonPartial, out.InvalidReason)
	require.Equal(t, "The page loaded only partially.", *h.getRun(out.RunID).Summary)
	require.Zero(t, h.agent.compareCount())
}

func TestIntegrationKeepsFailingAlertsOnce(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)

	h.failRun(m, capture.ReasonHTTPStatus)
	h.failRun(m, capture.ReasonChallenge)
	require.Zero(t, h.notifier.count(), "two failures are not a streak yet")

	h.failRun(m, capture.ReasonHTTPStatus)
	require.Equal(t, 1, h.notifier.count())
	alert := h.notifier.last()
	require.Equal(t, "Pricing: this Monitor keeps failing", alert.Subject)
	require.Equal(t, "failure", alert.WebhookEvent)
	require.Contains(t, *alert.Text, "The page responded with HTTP 503.")
	require.Contains(t, *alert.Text, "http://web.test/monitors/"+m)
	var body map[string]any
	require.NoError(t, json.Unmarshal(alert.Webhook, &body))
	require.Equal(t, "http_status", body["reason"])

	// It keeps failing: nobody is told again.
	h.failRun(m, capture.ReasonHTTPStatus)
	h.failRun(m, capture.ReasonHTTPStatus)
	require.Equal(t, 1, h.notifier.count())
	require.Equal(t, 5, h.state(m).ConsecutiveFailures)

	// A success ends the streak; a new one alerts anew.
	require.Equal(t, "none", h.step(m, page...).Verdict)
	require.Zero(t, h.state(m).ConsecutiveFailures)
	h.failRun(m, capture.ReasonEmpty)
	h.failRun(m, capture.ReasonEmpty)
	require.Equal(t, 1, h.notifier.count())
	h.failRun(m, capture.ReasonEmpty)
	require.Equal(t, 2, h.notifier.count())
}

func TestIntegrationKeepsFailingStaysQuietWhileSnoozed(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.exec(`UPDATE monitors SET snoozed_until = $2 WHERE id = $1`, m, time.Now().Add(time.Hour))
	for range 4 {
		h.failRun(m, capture.ReasonHTTPStatus)
	}
	require.Zero(t, h.notifier.count())
}

func TestIntegrationMacroOutcomeIsRecorded(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	m1 := h.macro(m, 1, "active")

	// The job names the active Macro.
	job, err := h.store.CreateRun(context.Background(), m, db.TriggerManual, h.env)
	require.NoError(t, err)
	require.Equal(t, db.ScrapeJobVersion, job.Version)
	require.Equal(t, m1, *job.MacroID)

	c := h.capture(m, job.RunID, page...)
	c.Macro = &capture.MacroResult{MacroID: m1, Status: capture.MacroOK}
	require.Equal(t, db.VerdictBaseline, h.process(c).Verdict)
	run := h.getRun(job.RunID)
	require.Equal(t, m1, *run.MacroID)
	require.Equal(t, "ok", *run.MacroStatus)
	require.Equal(t, h.config(m).CaptureVersionFor(&m1), *h.state(m).CaptureVersion)

	// The worker repairs the Macro during a Run and makes the repaired
	// version active. The page is still compared, not re-baselined, and the
	// repair's model usage is added to the comparison's.
	h.exec(`UPDATE macros SET status = 'archived' WHERE id = $1`, m1)
	m2 := h.macro(m, 2, "active")
	runID := h.run(m)
	c = h.capture(m, runID, withPrice("$59")...)
	c.Macro = &capture.MacroResult{MacroID: m1, Status: capture.MacroRepaired, RepairedMacroID: &m2, InputTokens: 300, OutputTokens: 40}
	out := h.process(c)
	require.Equal(t, "change", out.Verdict, "a repair does not swallow a Change")
	run = h.getRun(runID)
	require.Equal(t, m1, *run.MacroID, "the version the Run replayed")
	require.Equal(t, "repaired", *run.MacroStatus)
	require.Equal(t, 1300, run.InputTokens)
	require.Equal(t, 90, run.OutputTokens)
	require.Equal(t, h.config(m).CaptureVersionFor(&m2), *h.state(m).CaptureVersion)

	// The next Run replays the repaired version and compares as usual.
	job, err = h.store.CreateRun(context.Background(), m, db.TriggerManual, h.env)
	require.NoError(t, err)
	require.Equal(t, m2, *job.MacroID)
	c = h.capture(m, job.RunID, withPrice("$59")...)
	c.Macro = &capture.MacroResult{MacroID: m2, Status: capture.MacroOK}
	require.Equal(t, "none", h.process(c).Verdict)

	// The owner approves a new Macro: what is captured changes, so the next
	// Capture becomes the baseline silently.
	h.exec(`UPDATE macros SET status = 'archived' WHERE id = $1`, m2)
	m3 := h.macro(m, 3, "active")
	c = h.capture(m, h.run(m), "A different page behind another tab")
	c.Macro = &capture.MacroResult{MacroID: m3, Status: capture.MacroOK}
	require.Equal(t, db.VerdictBaseline, h.process(c).Verdict)
	require.Equal(t, 1, h.changeCount(m))
}

func TestIntegrationMacroFailedFailsTheRun(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	m1 := h.macro(m, 1, "active")
	c := h.capture(m, h.run(m), page...)
	c.Macro = &capture.MacroResult{MacroID: m1, Status: capture.MacroOK}
	h.process(c)
	before := h.state(m)

	runID := h.run(m)
	c = h.capture(m, runID)
	reason, step := capture.ReasonMacroFailed, 2
	c.Status, c.InvalidReason = capture.StatusInvalid, &reason
	c.Error = &capture.Error{Message: "Step 3 (Open the Billing tab) found no element to click."}
	c.Macro = &capture.MacroResult{MacroID: m1, Status: capture.MacroFailed, FailedStep: &step, InputTokens: 500, OutputTokens: 20}
	out := h.process(c)
	require.True(t, out.Failed)
	require.Equal(t, capture.ReasonMacroFailed, out.InvalidReason)

	run := h.getRun(runID)
	require.Equal(t, db.RunFailed, run.Status)
	require.Equal(t, capture.ReasonMacroFailed, *run.InvalidReason)
	require.Equal(t, "Step 3 (Open the Billing tab) found no element to click.", *run.Summary)
	require.Contains(t, string(run.Error), `"code": "macro_failed"`)
	require.Equal(t, m1, *run.MacroID)
	require.Equal(t, "failed", *run.MacroStatus)
	require.Equal(t, 500, run.InputTokens, "the failed repair was still paid for")
	require.Equal(t, before.PreviousRunID, h.state(m).PreviousRunID, "the baseline is untouched")
	require.Equal(t, 1, h.state(m).ConsecutiveFailures)

	// Without the worker's own words, the failed step is named.
	c = h.capture(m, h.run(m))
	c.Status, c.InvalidReason = capture.StatusInvalid, &reason
	c.Macro = &capture.MacroResult{MacroID: m1, Status: capture.MacroFailed, FailedStep: &step}
	h.process(c)
	require.Equal(t, "Step 3 of pre-scraping failed and could not be repaired.", *h.getRun(c.RunID).Summary)
}

func TestIntegrationEnvBumpRebaselinesSilently(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)

	h.env = "it-env-2"
	h.p = h.newPipeline(h.env)
	require.Equal(t, db.VerdictBaseline, h.step(m, withPrice("$59")...).Verdict)
	require.Zero(t, h.changeCount(m))
	require.Zero(t, h.agent.compareCount())
}

func TestIntegrationCaptureSettingsRebaselineSilently(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)

	h.exec(`UPDATE monitors SET viewport_w = 1280 WHERE id = $1`, m)
	require.Equal(t, db.VerdictBaseline, h.step(m, withPrice("$59")...).Verdict)

	// The instructions do not change what is captured.
	h.exec(`UPDATE monitors SET instructions = 'Prices only.' WHERE id = $1`, m)
	require.Equal(t, "change", h.step(m, withPrice("$69")...).Verdict)
}

func TestIntegrationConcurrentRunsAreSerialized(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)

	r1, r2 := h.run(m), h.run(m)
	var wg sync.WaitGroup
	outs := make([]Outcome, 2)
	for i, runID := range []string{r1, r2} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := h.p.Process(context.Background(), h.capture(m, runID, withPrice("$59")...))
			require.NoError(t, err)
			outs[i] = out
		}()
	}
	wg.Wait()

	verdicts := []string{outs[0].Verdict, outs[1].Verdict}
	require.ElementsMatch(t, []string{"change", "none"}, verdicts)
	require.Equal(t, 1, h.changeCount(m))
	require.Equal(t, 1, h.agent.compareCount())
}

func TestIntegrationDuplicateDeliveryIsIgnored(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.step(m, page...)
	c := h.capture(m, h.run(m), withPrice("$59")...)
	require.Equal(t, "change", h.process(c).Verdict)

	again := h.process(c)
	require.True(t, again.Duplicate)
	require.Equal(t, 1, h.changeCount(m))
	require.Equal(t, 1, h.notifier.count())
	require.Equal(t, 1, h.agent.compareCount())
}

// A Change raised after Runs that were recorded as Noise also carries the
// text since the owner last heard from us.
func TestIntegrationCumulativeSinceTheLastChange(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	base := h.step(m, "Headline", "Pro plan $49/month")

	h.agent.compare = notRelevant
	require.Equal(t, "noise", h.step(m, "Headline", "Pro plan $51/month").Verdict)
	h.agent.compare = nil
	out := h.step(m, "Headline", "Pro plan $59/month")
	require.Equal(t, "change", out.Verdict)

	rec := h.record(m, out.ChangeID)
	require.Equal(t, "$51", rec.Text.Ops[0].RemovedText(), "the step: since the previous Capture")
	require.NotNil(t, rec.Cumulative)
	require.Equal(t, base.RunID, rec.Cumulative.From.RunID)
	require.Equal(t, "$49", rec.Cumulative.Text.Ops[0].RemovedText(), "cumulative: since the last Change")
	require.Equal(t, out.RunID, *h.state(m).LastNotifiedRunID)
}

func TestIntegrationVisualChangeWithoutAPlan(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	blocks := []capture.Block{
		block("title", "/html/body/h1", "Acme", geom.Rect{20, 20, 300, 40}),
		block("hero", "/html/body/main/figure", "", geom.Rect{20, 100, 300, 150}),
	}
	shot := func(runID string, fill box) capture.Capture {
		return h.withShot(h.captureOf(m, runID, blocks), drawShot(400, 400, box{geom.Rect{20, 20, 300, 40}, grey}, fill))
	}
	base := h.run(m)
	require.Equal(t, db.VerdictBaseline, h.process(shot(base, box{geom.Rect{20, 100, 300, 150}, red})).Verdict)
	require.Equal(t, "none", h.process(shot(h.run(m), box{geom.Rect{20, 100, 300, 150}, red})).Verdict)
	require.Zero(t, h.agent.compareCount())

	// Only the picture changes: no text op, one region.
	out := h.process(shot(h.run(m), box{geom.Rect{20, 100, 300, 150}, blue}))
	require.Equal(t, "change", out.Verdict)
	req := h.agent.lastCompare()
	require.Empty(t, req.Text.Ops)
	require.Len(t, req.Regions, 1)
	require.Empty(t, req.Regions[0].Section)
	require.Equal(t, [2]int{400, 400}, req.SizeBefore)
	require.Equal(t, [2]int{400, 400}, req.SizeAfter)
	require.NotEmpty(t, req.To.Screenshot)

	rec := h.record(m, out.ChangeID)
	require.Len(t, rec.Visual.Regions, 1)
	require.Equal(t, []string{"hero"}, rec.Visual.Regions[0].Blocks)
	require.Len(t, rec.Items, 1)
	require.Equal(t, changerecord.ItemVisual, rec.Items[0].Kind)
	require.Equal(t, []int{0}, rec.Items[0].Regions)
	require.Equal(t, &rec.Visual.Regions[0].Box, rec.Items[0].RectAfter)
	require.Equal(t, rec.Visual.Regions[0].FromBox, rec.Items[0].RectBefore)
	require.Equal(t, objects.DiffImageKey(m, out.ChangeID), rec.Visual.DiffImage)
	require.Equal(t, objects.CropKey(m, out.ChangeID), rec.Visual.Crop)
	require.Equal(t, []string{"visual"}, h.change(out.ChangeID).Dimensions)
	require.NotNil(t, h.notifier.last().ImageURL)

	// The screenshot's size is kept with the Capture.
	row, err := h.store.GetCapture(context.Background(), base)
	require.NoError(t, err)
	require.Equal(t, [2]int{400, 400}, screenshotSize(row.Meta))
	require.NotNil(t, row.DHash)
}

func TestIntegrationCompareOnDemand(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	first := h.step(m, page...)
	second := h.step(m, withPrice("$59")...)
	calls := h.agent.compareCount()

	rec, err := h.p.Compare(context.Background(), first.RunID, second.RunID)
	require.NoError(t, err)
	require.Equal(t, decide.StatusChange, rec.Status)
	require.Equal(t, "1 word added, 1 removed", rec.Summary)
	require.Nil(t, rec.Agent)
	require.Empty(t, rec.Items)
	require.Len(t, rec.Text.Ops, 1)
	require.Equal(t, calls, h.agent.compareCount(), "the agent is not asked")
	require.Equal(t, 1, h.changeCount(m), "nothing is stored")

	same, err := h.p.Compare(context.Background(), second.RunID, second.RunID)
	require.NoError(t, err)
	require.Equal(t, decide.StatusNoise, same.Status)
	require.Equal(t, "No difference", same.Summary)

	other := h.monitor("")
	elsewhere := h.step(other, page...)
	_, err = h.p.Compare(context.Background(), first.RunID, elsewhere.RunID)
	require.ErrorIs(t, err, ErrBadRequest)
}

func TestIntegrationAcceptBaseline(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.exec(`UPDATE monitors SET confirm_changes = true WHERE id = $1`, m)
	first := h.step(m, page...)
	require.Equal(t, "pending", h.step(m, withPrice("$59")...).Verdict)

	require.NoError(t, h.p.AcceptBaseline(context.Background(), m, first.RunID))
	s := h.state(m)
	require.Equal(t, first.RunID, *s.PreviousRunID)
	require.Equal(t, first.RunID, *s.LastNotifiedRunID)
	require.Nil(t, s.PendingChangeID)
	require.Equal(t, "none", h.step(m, page...).Verdict)

	other := h.monitor("")
	require.ErrorIs(t, h.p.AcceptBaseline(context.Background(), other, first.RunID), ErrBadRequest)
}

func TestIntegrationDigestUrgencyQueuesInsteadOfSending(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.exec(`UPDATE monitors SET urgency = 'hourly' WHERE id = $1`, m)
	h.step(m, page...)

	out := h.step(m, withPrice("$59")...)
	require.Equal(t, "change", out.Verdict)
	require.True(t, out.Digest)
	require.Zero(t, h.notifier.count())

	// Only this test's items are sent: the database is shared, and a digest
	// run over everything would swallow other owners' items.
	rows, err := h.store.UnsentDigestItems(context.Background(), "hourly")
	require.NoError(t, err)
	var mine []db.DigestRow
	for _, r := range rows {
		if r.UserID == h.userID {
			mine = append(mine, r)
		}
	}
	require.Len(t, mine, 1)
	require.Equal(t, "The agent says this matters.", mine[0].Summary)

	res, err := h.p.sendDigests(context.Background(), "hourly", mine)
	require.NoError(t, err)
	require.Equal(t, DigestResult{Owners: 1, Changes: 1}, res)
	require.Equal(t, 1, h.notifier.count())
	digest := h.notifier.last()
	require.Equal(t, "Hourly digest: 1 change on 1 monitor", digest.Subject)
	require.Contains(t, *digest.Text, "The agent says this matters.", "a digest lists each Change's summary")

	_, err = h.p.RunDigests(context.Background(), "weekly")
	require.ErrorIs(t, err, ErrBadRequest)
}

func TestIntegrationSnoozedRecordsWithoutNotifying(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.exec(`UPDATE monitors SET snoozed_until = $2 WHERE id = $1`, m, time.Now().Add(time.Hour))
	h.step(m, page...)

	out := h.step(m, withPrice("$59")...)
	require.Equal(t, "change", out.Verdict)
	require.Zero(t, h.notifier.count())
	require.Equal(t, 1, h.changeCount(m))
}

func TestIntegrationStaleRunsAreFailed(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	stale, fresh := h.run(m), h.run(m)
	// The set_updated_at trigger would overwrite a backdated updated_at, so
	// skip triggers for this one statement. The date is far in the past and
	// the cutoff right after it, so no Run of anybody else can be caught.
	tx, err := h.pool.Begin(context.Background())
	require.NoError(t, err)
	_, err = tx.Exec(context.Background(), `SET LOCAL session_replication_role = replica`)
	require.NoError(t, err)
	_, err = tx.Exec(context.Background(), `UPDATE monitor_runs SET updated_at = '2001-01-01' WHERE id = $1`, stale)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(context.Background()))

	n, err := h.store.FailStaleRuns(context.Background(), time.Date(2001, 1, 2, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Equal(t, int64(1), n)

	run := h.getRun(stale)
	require.Equal(t, db.RunFailed, run.Status)
	require.Contains(t, string(run.Error), `"timeout"`)
	require.Contains(t, *run.Summary, "No Capture arrived")
	require.Equal(t, db.RunProcessing, h.getRun(fresh).Status)
}

func TestIntegrationUnknownRunIsPermanent(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	_, err := h.p.Process(context.Background(), h.capture(m, "00000000-0000-4000-8000-000000000000", page...))
	require.ErrorIs(t, err, ErrPermanent)

	other := h.monitor("")
	_, err = h.p.Process(context.Background(), h.capture(other, h.run(m), page...))
	require.True(t, errors.Is(err, ErrPermanent))
}
