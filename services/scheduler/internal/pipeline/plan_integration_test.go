package pipeline

import (
	"context"
	"errors"
	"fmt"
	"testing"

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

// The page the Watch Plan tests capture: a pricing table, a chart, rotating
// testimonials and a footer.
const (
	pathTitle  = "/html/body/main/h1"
	pathPrices = "/html/body/main/section[1]"
	pathChart  = "/html/body/main/figure"
	pathQuotes = "/html/body/main/section[2]"
	pathFooter = "/html/body/footer"
)

var (
	rectTitle  = geom.Rect{20, 20, 360, 30}
	rectPrice  = geom.Rect{20, 70, 360, 24}
	rectChart  = geom.Rect{20, 120, 300, 120}
	rectQuote  = geom.Rect{20, 260, 360, 24}
	rectFooter = geom.Rect{20, 320, 360, 24}
)

// sitePage is one Capture of that page.
type sitePage struct {
	price, quote, footer string
	// chartText is the caption inside the chart.
	chartText string
	// noChart drops the chart from the page.
	noChart bool
}

func (p sitePage) blocks() []capture.Block {
	if p.price == "" {
		p.price = "Pro plan $49/month"
	}
	if p.quote == "" {
		p.quote = "“We switched in a day.”"
	}
	if p.footer == "" {
		p.footer = "Acme Inc, Berlin"
	}
	if p.chartText == "" {
		p.chartText = "Price history"
	}
	blocks := []capture.Block{
		block("title", pathTitle, "Acme pricing", rectTitle),
		block("price", pathPrices+"/p[1]", p.price, rectPrice),
	}
	if !p.noChart {
		blocks = append(blocks, block("chart", pathChart+"/figcaption", p.chartText, rectChart))
	}
	return append(blocks,
		block("quote", pathQuotes+"/blockquote", p.quote, rectQuote),
		block("footer", pathFooter+"/p", p.footer, rectFooter),
	)
}

func section(id, name string, how monitor.WatchHow, paths ...string) monitor.WatchSection {
	return monitor.WatchSection{ID: id, Name: name, How: how, Why: "Because.", Paths: paths}
}

// planOf makes the fake agent answer every plan request with these Sections.
func planOf(rest monitor.WatchHow, sections ...monitor.WatchSection) func(agentclient.PlanRequest) (agentclient.PlanResponse, error) {
	return func(agentclient.PlanRequest) (agentclient.PlanResponse, error) {
		return agentclient.PlanResponse{
			Sections: sections, Rest: rest, Summary: "Watching what you asked about.",
			Model: "plan-model", InputTokens: 2000, OutputTokens: 150, Steps: 1,
		}, nil
	}
}

func (h *harness) site(m string, p sitePage) Outcome {
	h.t.Helper()
	return h.process(h.captureOf(m, h.run(m), p.blocks()))
}

func TestIntegrationBaselineMakesAWatchPlan(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("Tell me when a price changes.")
	h.agent.plan = planOf(monitor.HowText,
		section("prices", "Pricing table", monitor.HowBoth, pathPrices),
		section("quotes", "Testimonials", monitor.HowIgnore, pathQuotes),
	)

	out := h.site(m, sitePage{})
	require.Equal(t, db.VerdictBaseline, out.Verdict)
	require.True(t, out.Planned)

	// What the agent was asked.
	require.Equal(t, 1, h.agent.planCount())
	req := h.agent.lastPlan()
	require.Equal(t, out.RunID, req.RunID)
	require.Equal(t, m, req.MonitorID)
	require.Equal(t, h.userID, req.UserID)
	require.Equal(t, "Tell me when a price changes.", req.Monitor.Instructions)
	require.Equal(t, h.connID, *req.ConnectionID)
	require.Equal(t, out.RunID, req.Capture.RunID)
	require.Equal(t, objects.BlocksKey(m, out.RunID), req.Capture.Blocks, "the Capture is stored before the agent is asked to read it")
	require.Nil(t, req.Previous)

	// What was saved.
	plan := h.config(m).WatchPlan
	require.NotNil(t, plan)
	require.Equal(t, monitor.WatchPlanVersion, plan.Version)
	require.Equal(t, []string{"prices", "quotes"}, []string{plan.Sections[0].ID, plan.Sections[1].ID})
	require.Equal(t, monitor.HowText, plan.Rest)
	require.Equal(t, "Watching what you asked about.", plan.Summary)
	require.Equal(t, monitor.InstructionsHash("Tell me when a price changes."), plan.InstructionsHash)
	require.Equal(t, out.RunID, plan.RunID)
	require.Equal(t, "plan-model", plan.Model)
	require.False(t, plan.CreatedAt.IsZero())

	// The plan's model usage counts towards the Run.
	run := h.getRun(out.RunID)
	require.Equal(t, 2000, run.InputTokens)
	require.Equal(t, 150, run.OutputTokens)

	// With the plan in step with the page and the instructions, later Runs
	// do not plan again.
	require.Equal(t, "none", h.site(m, sitePage{}).Verdict)
	require.Equal(t, "change", h.site(m, sitePage{price: "Pro plan $59/month"}).Verdict)
	require.Equal(t, 1, h.agent.planCount())
	require.Zero(t, h.state(m).PlanStaleRuns)
}

func TestIntegrationPlanGuard(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")

	// Nothing the agent proposes fits the page: the Monitor keeps having no
	// plan, and the Run is none the worse for it.
	h.agent.plan = planOf("sideways",
		section("nav", "Navigation", monitor.HowText, "/html/body/nav"),
		section("odd", "Odd", "sometimes", pathPrices),
	)
	out := h.site(m, sitePage{})
	require.Equal(t, db.VerdictBaseline, out.Verdict)
	require.False(t, out.Planned)
	require.Nil(t, h.config(m).WatchPlan)
	require.Equal(t, 2000, h.getRun(out.RunID).InputTokens, "the model was called all the same")

	// The agent cannot be reached at all.
	h.agent.plan = func(agentclient.PlanRequest) (agentclient.PlanResponse, error) {
		return agentclient.PlanResponse{}, errors.New("agent API unreachable")
	}
	h.exec(`UPDATE monitors SET viewport_w = 1280 WHERE id = $1`, m) // re-baseline, to plan again
	out = h.site(m, sitePage{})
	require.Equal(t, db.VerdictBaseline, out.Verdict)
	require.False(t, out.Planned)
	require.Nil(t, h.config(m).WatchPlan)

	// A mixed answer: what fits is kept, what does not is dropped, and a
	// `rest` nobody knows widens to both.
	var many []monitor.WatchSection
	many = append(many,
		section("gone", "Not on this page", monitor.HowText, "/html/body/nav"),
		section("odd", "Odd how", "sometimes", pathPrices),
		section("prices", " Pricing table ", monitor.HowBoth, pathPrices+"/", pathPrices),
		section("prices", "Same id again", monitor.HowIgnore, pathFooter),
	)
	for i := range 30 {
		many = append(many, section(fmt.Sprintf("s%d", i), "", monitor.HowIgnore, pathFooter))
	}
	h.agent.plan = planOf("sideways", many...)
	h.exec(`UPDATE monitors SET viewport_w = 1366 WHERE id = $1`, m)
	out = h.site(m, sitePage{})
	require.True(t, out.Planned)
	plan := h.config(m).WatchPlan
	require.Len(t, plan.Sections, monitor.MaxSections)
	require.Equal(t, monitor.WatchSection{ID: "prices", Name: "Pricing table", How: monitor.HowBoth, Why: "Because.", Paths: []string{pathPrices}}, plan.Sections[0])
	require.Equal(t, "s0", plan.Sections[1].ID)
	require.Equal(t, monitor.HowBoth, plan.Rest)

	// A later plan that comes back empty leaves the saved one as it was.
	h.agent.plan = planOf(monitor.HowText, section("nav", "Navigation", monitor.HowText, "/html/body/nav"))
	h.exec(`UPDATE monitors SET viewport_w = 1280 WHERE id = $1`, m)
	out = h.site(m, sitePage{})
	require.False(t, out.Planned)
	require.Equal(t, plan, h.config(m).WatchPlan)
}

func TestIntegrationNewInstructionsMakeANewPlan(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("Tell me when a price changes.")
	h.agent.plan = planOf(monitor.HowIgnore, section("prices", "Pricing table", monitor.HowText, pathPrices))
	h.site(m, sitePage{})
	first := h.config(m).WatchPlan
	require.Equal(t, 1, h.agent.planCount())

	// The owner now cares about the footer too. The plan is remade before
	// this Run is compared, so the footer's change is not lost to the old
	// plan, which ignored everything outside the pricing table.
	h.exec(`UPDATE monitors SET instructions = 'Prices, and the company address.' WHERE id = $1`, m)
	h.agent.plan = planOf(monitor.HowIgnore,
		section("prices", "Pricing table", monitor.HowText, pathPrices),
		section("address", "Footer address", monitor.HowText, pathFooter),
	)
	out := h.site(m, sitePage{footer: "Acme Inc, Munich"})
	require.True(t, out.Planned)
	require.Equal(t, 2, h.agent.planCount())
	require.Equal(t, first, h.agent.lastPlan().Previous, "the old plan is passed along, so ids and the owner's edits carry over")
	require.Equal(t, "Prices, and the company address.", h.agent.lastPlan().Monitor.Instructions)

	plan := h.config(m).WatchPlan
	require.Equal(t, monitor.InstructionsHash("Prices, and the company address."), plan.InstructionsHash)
	require.Equal(t, out.RunID, plan.RunID)
	require.Len(t, plan.Sections, 2)

	require.Equal(t, "change", out.Verdict)
	req := h.agent.lastCompare()
	require.Equal(t, plan, req.Plan, "the comparison is made under the new plan")
	require.Len(t, req.Text.Ops, 1)
	require.Equal(t, "address", req.Text.Ops[0].Section)
	run := h.getRun(out.RunID)
	require.Equal(t, 3000, run.InputTokens, "the plan's usage and the comparison's")

	// Nothing changed since: no more planning.
	h.site(m, sitePage{footer: "Acme Inc, Munich"})
	require.Equal(t, 2, h.agent.planCount())
}

func TestIntegrationStalePlanIsRemadeAfterThreeRuns(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.agent.plan = planOf(monitor.HowText,
		section("chart", "Price chart", monitor.HowBoth, pathChart),
		section("quotes", "Testimonials", monitor.HowIgnore, pathQuotes),
	)
	h.site(m, sitePage{})
	require.Equal(t, 1, h.agent.planCount())
	old := h.config(m).WatchPlan

	// The site drops the chart: a watched Section matches nothing.
	h.agent.plan = planOf(monitor.HowText, section("prices", "Pricing table", monitor.HowText, pathPrices))
	h.site(m, sitePage{noChart: true})
	require.Equal(t, 1, h.state(m).PlanStaleRuns)
	h.site(m, sitePage{noChart: true})
	require.Equal(t, 2, h.state(m).PlanStaleRuns)
	require.Equal(t, 1, h.agent.planCount(), "two Runs are not enough")

	out := h.site(m, sitePage{noChart: true})
	require.True(t, out.Planned)
	require.Equal(t, 2, h.agent.planCount())
	require.Equal(t, old, h.agent.lastPlan().Previous)
	require.Zero(t, h.state(m).PlanStaleRuns)
	require.Equal(t, "prices", h.config(m).WatchPlan.Sections[0].ID)

	// A page that fits the plan again in between starts the count over.
	h.agent.plan = planOf(monitor.HowText, section("chart", "Price chart", monitor.HowBoth, pathChart))
	h.exec(`UPDATE monitors SET viewport_w = 1280 WHERE id = $1`, m)
	h.site(m, sitePage{})
	require.Equal(t, 3, h.agent.planCount())
	h.site(m, sitePage{noChart: true})
	h.site(m, sitePage{noChart: true})
	h.site(m, sitePage{})
	require.Zero(t, h.state(m).PlanStaleRuns)
	h.site(m, sitePage{noChart: true})
	h.site(m, sitePage{noChart: true})
	require.Equal(t, 3, h.agent.planCount())

	// An ignored Section that goes away is no reason to plan again.
	h.exec(`UPDATE monitors SET watch_plan = jsonb_set(watch_plan, '{sections,0,how}', '"ignore"') WHERE id = $1`, m)
	for range 4 {
		h.site(m, sitePage{noChart: true})
	}
	require.Equal(t, 3, h.agent.planCount())
}

// A Monitor that has a connection but no plan (the agent was down when the
// baseline was taken) gets one a few Runs later, not never.
func TestIntegrationMissingPlanIsMadeLater(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.site(m, sitePage{})
	require.Equal(t, 1, h.agent.planCount())
	require.Nil(t, h.config(m).WatchPlan)

	h.agent.plan = planOf(monitor.HowText, section("prices", "Pricing table", monitor.HowText, pathPrices))
	h.site(m, sitePage{})
	h.site(m, sitePage{})
	require.Equal(t, 1, h.agent.planCount())
	out := h.site(m, sitePage{})
	require.True(t, out.Planned)
	require.Equal(t, "none", out.Verdict)
	require.NotNil(t, h.config(m).WatchPlan)
}

func TestIntegrationIgnoredSectionIsNoiseWithoutAModelCall(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.agent.plan = planOf(monitor.HowText,
		section("prices", "Pricing table", monitor.HowText, pathPrices),
		section("quotes", "Testimonials", monitor.HowIgnore, pathQuotes),
	)
	h.site(m, sitePage{})

	out := h.site(m, sitePage{quote: "“Support answered in minutes.”"})
	require.Equal(t, "noise", out.Verdict)
	require.Zero(t, h.agent.compareCount(), "ignored Sections never reach the model")
	require.Zero(t, h.notifier.count())

	row := h.change(out.ChangeID)
	require.Equal(t, []string{decide.ReasonIgnoredSection}, row.SuppressedBy)
	require.Equal(t, "Only Testimonials changed, which this Monitor does not watch for text", row.Summary)
	require.Empty(t, row.Agent)
	rec := h.record(m, out.ChangeID)
	require.Nil(t, rec.Agent)
	require.Len(t, rec.Text.Ops, 1)
	require.Equal(t, diff.OpIgnored, rec.Text.Ops[0].Op, "the difference is kept in the record, as ignored")
	require.Equal(t, "quotes", rec.Text.Ops[0].Section)
	require.Equal(t, 1, rec.Text.IgnoredCount)
	require.Equal(t, []changerecord.SectionRef{{ID: "prices", Name: "Pricing table", How: "text"}, {ID: "quotes", Name: "Testimonials", How: "ignore"}}, rec.Sections)
	require.Equal(t, *h.getRun(out.RunID).Summary, row.Summary)

	// A watched Section changes along with the ignored one: the agent is
	// asked, about the watched difference only.
	out = h.site(m, sitePage{price: "Pro plan $59/month", quote: "“Best decision this year.”"})
	require.Equal(t, "change", out.Verdict)
	req := h.agent.lastCompare()
	require.Len(t, req.Text.Ops, 1, "the ignored op is not sent")
	require.Equal(t, "prices", req.Text.Ops[0].Section)
	require.Equal(t, 1, req.Text.IgnoredCount)

	// The record keeps both ops, and the item cites the watched one by its
	// place in the record, not in the request.
	rec = h.record(m, out.ChangeID)
	require.Len(t, rec.Text.Ops, 2)
	require.Len(t, rec.Items, 1)
	cited := rec.Text.Ops[rec.Items[0].Ops[0]]
	require.Equal(t, diff.OpModify, cited.Op)
	require.Equal(t, "prices", cited.Section)
	require.Equal(t, "Pricing table", rec.ItemSection(rec.Items[0]))
}

func TestIntegrationVisualOnlySectionDoesNotCountItsText(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	h.agent.plan = planOf(monitor.HowText, section("chart", "Price chart", monitor.HowVisual, pathChart))
	h.site(m, sitePage{})

	// The caption inside the chart changes. The owner watches how the chart
	// looks, not its words (and these Captures have no screenshots).
	out := h.site(m, sitePage{chartText: "Price history, updated"})
	require.Equal(t, "noise", out.Verdict)
	require.Equal(t, []string{decide.ReasonIgnoredSection}, h.change(out.ChangeID).SuppressedBy)
	require.Zero(t, h.agent.compareCount())
	rec := h.record(m, out.ChangeID)
	require.Equal(t, diff.OpIgnored, rec.Text.Ops[0].Op)
	require.Equal(t, "chart", rec.Text.Ops[0].Section)

	// Text outside the Section still counts, as `rest` says.
	require.Equal(t, "change", h.site(m, sitePage{chartText: "Price history, updated", footer: "Acme Inc, Munich"}).Verdict)
	require.Empty(t, h.agent.lastCompare().Text.Ops[0].Section, "outside every Section")
}

// shotPage is the site page with a screenshot: every block drawn as a box,
// optionally pushed down by a banner inserted at the top.
func (h *harness) shotPage(m string, p sitePage, chartFill, footerFill [3]uint8, bannerH int) capture.Capture {
	h.t.Helper()
	blocks := p.blocks()
	var boxes []box
	for i := range blocks {
		r := blocks[i].Rect
		r[1] += bannerH
		blocks[i].Rect = r
		fill := grey
		switch blocks[i].ID {
		case "chart":
			fill.R, fill.G, fill.B = chartFill[0], chartFill[1], chartFill[2]
		case "footer":
			fill.R, fill.G, fill.B = footerFill[0], footerFill[1], footerFill[2]
		}
		boxes = append(boxes, box{r, fill})
	}
	if bannerH > 0 {
		boxes = append(boxes, box{geom.Rect{0, 0, 400, bannerH - 4}, green})
	}
	return h.withShot(h.captureOf(m, h.run(m), blocks), drawShot(400, 360+bannerH, boxes...))
}

var (
	chartRed  = [3]uint8{200, 30, 30}
	chartBlue = [3]uint8{30, 60, 200}
	footGrey  = [3]uint8{120, 120, 120}
	footGreen = [3]uint8{30, 160, 60}
)

func TestIntegrationSectionCropComparison(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("Tell me when the chart changes.")
	// Only the chart is watched for looks; nothing else is compared visually.
	h.agent.plan = planOf(monitor.HowText, section("chart", "Price chart", monitor.HowVisual, pathChart))
	require.Equal(t, db.VerdictBaseline, h.process(h.shotPage(m, sitePage{}, chartRed, footGrey, 0)).Verdict)

	// A banner appears above and the footer is repainted. The chart moved
	// down but looks the same, and nothing else is watched for looks.
	out := h.process(h.shotPage(m, sitePage{}, chartRed, footGreen, 60))
	require.Equal(t, "none", out.Verdict)
	require.Zero(t, h.agent.compareCount())

	// Now the chart itself is redrawn, still below the banner.
	out = h.process(h.shotPage(m, sitePage{}, chartBlue, footGreen, 60))
	require.Equal(t, "change", out.Verdict)

	req := h.agent.lastCompare()
	require.NotNil(t, req.Plan)
	require.Equal(t, "chart", req.Plan.Sections[0].ID)
	require.Empty(t, req.Text.Ops)
	require.NotEmpty(t, req.Regions)
	after := geom.Rect{rectChart.X(), rectChart.Y() + 60, rectChart.W(), rectChart.H()}
	for _, r := range req.Regions {
		require.Equal(t, "chart", r.Section, "every region says which Section it is in")
		require.True(t, r.Box.Image().In(after.Image()), "region %v lies in the chart %v", r.Box, after)
	}
	require.Equal(t, [2]int{400, 420}, req.SizeBefore)

	rec := h.record(m, out.ChangeID)
	require.Equal(t, "chart", rec.Visual.Regions[0].Section)
	require.Equal(t, []string{"chart"}, rec.Visual.Regions[0].Blocks)
	require.Len(t, rec.Items, 1)
	require.Equal(t, changerecord.ItemVisual, rec.Items[0].Kind)
	require.True(t, rec.Items[0].RectAfter.Image().In(after.Image()))
	require.True(t, rec.Items[0].RectBefore.Image().In(after.Image()), "the previous Capture had the banner too")
	require.Equal(t, "Price chart", rec.ItemSection(rec.Items[0]))
	require.Equal(t, []string{"visual"}, h.change(out.ChangeID).Dimensions)

	// The banner goes away again while the chart changes once more: the
	// before and after boxes differ by the banner's height.
	out = h.process(h.shotPage(m, sitePage{}, chartRed, footGreen, 0))
	require.Equal(t, "change", out.Verdict)
	rec = h.record(m, out.ChangeID)
	require.True(t, rec.Items[0].RectAfter.Image().In(rectChart.Image()))
	require.True(t, rec.Items[0].RectBefore.Image().In(after.Image()))
}

func TestIntegrationRestPass(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("")
	// The chart is ignored; everything else is watched for words and looks.
	h.agent.plan = planOf(monitor.HowBoth, section("chart", "Price chart", monitor.HowIgnore, pathChart))
	h.process(h.shotPage(m, sitePage{}, chartRed, footGrey, 0))

	// The ignored chart is repainted: nothing to report.
	require.Equal(t, "none", h.process(h.shotPage(m, sitePage{}, chartBlue, footGrey, 0)).Verdict)
	require.Zero(t, h.agent.compareCount())

	// The footer is repainted: found by the rest pass, outside every Section.
	out := h.process(h.shotPage(m, sitePage{}, chartBlue, footGreen, 0))
	require.Equal(t, "change", out.Verdict)
	req := h.agent.lastCompare()
	require.Len(t, req.Regions, 1)
	require.Empty(t, req.Regions[0].Section)
	require.True(t, req.Regions[0].Box.Image().Overlaps(rectFooter.Image()))
	rec := h.record(m, out.ChangeID)
	require.Equal(t, []string{"footer"}, rec.Visual.Regions[0].Blocks)
	require.Empty(t, rec.ItemSection(rec.Items[0]))
}

func TestIntegrationPlanAgainOnDemand(t *testing.T) {
	h := newHarness(t)
	m := h.monitor("Prices.")

	// No Capture yet: nothing to plan from.
	_, err := h.p.Replan(context.Background(), m)
	require.ErrorIs(t, err, ErrBadRequest)

	base := h.site(m, sitePage{})
	require.Nil(t, h.config(m).WatchPlan)
	require.Zero(t, h.getRun(base.RunID).InputTokens)

	h.agent.plan = planOf(monitor.HowIgnore, section("prices", "Pricing table", monitor.HowText, pathPrices))
	plan, err := h.p.Replan(context.Background(), m)
	require.NoError(t, err)
	require.Equal(t, "prices", plan.Sections[0].ID)
	require.Equal(t, base.RunID, plan.RunID, "planned from the latest valid Capture")
	require.Equal(t, monitor.InstructionsHash("Prices."), plan.InstructionsHash)
	require.Equal(t, plan, *h.config(m).WatchPlan, "the answer is the plan that was saved")
	require.Equal(t, base.RunID, h.agent.lastPlan().Capture.RunID)
	require.Equal(t, 2000, h.getRun(base.RunID).InputTokens, "its usage is added to the Run it planned from")

	// The agent fails: the saved plan stays.
	h.agent.plan = nil
	_, err = h.p.Replan(context.Background(), m)
	require.ErrorIs(t, err, ErrAgent)
	require.Equal(t, plan, *h.config(m).WatchPlan)

	// Without a connection there is nobody to ask.
	h.exec(`UPDATE monitors SET connection_id = NULL WHERE id = $1`, m)
	_, err = h.p.Replan(context.Background(), m)
	require.ErrorIs(t, err, ErrBadRequest)

	_, err = h.p.Replan(context.Background(), "00000000-0000-4000-8000-000000000000")
	require.ErrorIs(t, err, db.ErrNotFound)
}
