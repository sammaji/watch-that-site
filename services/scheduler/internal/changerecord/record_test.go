package changerecord

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

var update = flag.Bool("update", false, "rewrite the golden Change Record")

// goldenPath is shared with packages/types, whose vitest suite reads the
// same file, so the Go and TypeScript definitions cannot drift apart.
const goldenPath = "testdata/change_record.json"

func fixture() Record {
	at := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	rect := geom.Rect{120, 1840, 640, 28}
	fromRect := geom.Rect{120, 1792, 640, 28}
	chart := geom.Rect{120, 2000, 480, 260}
	chartFrom := geom.Rect{120, 1952, 480, 260}
	cfg := monitor.Config{
		ID:           "7f1f5f3e-4e3b-4e7a-9d8e-2f1f7c3a9b10",
		Name:         "Acme pricing",
		URL:          "https://acme.test/pricing",
		Instructions: "Tell me when a plan's price changes. Ignore the testimonials.",
		WatchPlan: &monitor.WatchPlan{
			Version: monitor.WatchPlanVersion,
			Sections: []monitor.WatchSection{
				{ID: "plans", Name: "Pricing table", How: monitor.HowBoth, Why: "Prices are what you asked about.", Paths: []string{"/html/body/main/section[2]"}},
				{ID: "testimonials", Name: "Testimonials", How: monitor.HowIgnore, Why: "They rotate on every visit.", Paths: []string{"/html/body/main/section[3]"}},
			},
			Rest: monitor.HowText,
		},
	}

	return Build(BuildInput{
		ChangeID: "0c9f2d1e-8b7a-4c3d-9e2f-1a0b9c8d7e6f",
		Monitor:  cfg,
		From:     RunRef{RunID: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", At: at.Add(-24 * time.Hour), Screenshot: "captures/m/r1/shot.png", Blocks: "captures/m/r1/blocks.json.gz"},
		To:       RunRef{RunID: "2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c", At: at, Screenshot: "captures/m/r2/shot.png", Blocks: "captures/m/r2/blocks.json.gz"},
		Verdict: decide.Verdict{
			Status: decide.StatusChange,
			Why: []decide.Why{
				{Kind: decide.WhyAgent, Detail: "The agent found a change that matches this Monitor's instructions."},
				{Kind: decide.WhyPersistence, Reason: decide.NotePersistence, Detail: "Seen on two consecutive checks."},
			},
		},
		Step: diff.Evidence{
			Text: &diff.TextEvidence{
				Ops: []diff.TextOp{
					{
						Op: diff.OpModify, BlockID: "b17", FromBlockID: "b17", Path: "/html/body/main/section[2]/ul/li[3]", Tag: "li",
						Rect: &rect, FromRect: &fromRect,
						Tokens:        []diff.WordOp{{Op: "=", Text: "Pro plan — "}, {Op: "-", Text: "$49"}, {Op: "+", Text: "$59"}, {Op: "=", Text: "/month"}},
						ContextBefore: []string{"Starter plan — $19/month"}, ContextAfter: []string{"Enterprise — contact us"},
						Section: "plans",
					},
					{
						Op: diff.OpIgnored, BlockID: "b40", FromBlockID: "b40", Path: "/html/body/main/section[3]/blockquote", Tag: "blockquote",
						Text: "“We switched in a day.”", OldText: "“Support answered in minutes.”",
						Masked: []string{"reltime"}, Section: "testimonials",
					},
				},
				Magnitude:    diff.TextMagnitude{WordsAdded: 1, WordsRemoved: 1, BlocksChanged: 1, ChangeRatio: 0.05},
				IgnoredCount: 1,
				Masked:       []string{"reltime"},
			},
			Visual: &diff.VisualEvidence{
				Regions:    []diff.Region{{Box: chart, Kind: diff.RegionChanged, Pixels: 812, Blocks: []string{"b21"}, FromBox: &chartFrom, Section: "plans"}},
				Shift:      &diff.Shift{FromY: 148, DY: 48},
				AreaRatio:  0.004,
				SizeBefore: [2]int{1366, 3000},
				SizeAfter:  [2]int{1366, 3048},
			},
		},
		Summary: "The Pro plan went from $49 to $59 per month.",
		Items: []Item{
			{Title: "Pro plan price raised", Before: "$49/month", After: "$59/month", Kind: ItemText, Matches: "a plan's price changes", Ops: []int{0}, Regions: []int{}},
			{Title: "Price comparison chart redrawn", Before: "Pro bar at $49", After: "Pro bar at $59", Kind: ItemVisual, Matches: "a plan's price changes", Ops: []int{}, Regions: []int{0}},
		},
		Ignored: []Ignored{{Note: "A new banner about the autumn sale", Reason: "Not a plan price."}},
		Agent: &AgentVerdict{
			Relevant: true, Importance: ImportanceHigh, Model: "gpt-5.1",
			InputTokens: 4210, OutputTokens: 318, Steps: 2,
		},
		Cumulative: &diff.Evidence{Text: &diff.TextEvidence{
			Ops: []diff.TextOp{{
				Op: diff.OpModify, BlockID: "b17", FromBlockID: "b17", Path: "/html/body/main/section[2]/ul/li[3]", Tag: "li",
				Tokens:  []diff.WordOp{{Op: "=", Text: "Pro plan — "}, {Op: "-", Text: "$45"}, {Op: "+", Text: "$59"}, {Op: "=", Text: "/month"}},
				Section: "plans",
			}},
			Magnitude: diff.TextMagnitude{WordsAdded: 1, WordsRemoved: 1, BlocksChanged: 1, ChangeRatio: 0.05},
		}},
		CumulativeFrom: RunRef{RunID: "0a1b2c3d-4e5f-4607-8192-a3b4c5d6e7f8", At: at.Add(-72 * time.Hour), Screenshot: "captures/m/r0/shot.png", Blocks: "captures/m/r0/blocks.json.gz"},
		DiffImageKey:   "changes/m/c-diff.png",
		CropKey:        "changes/m/c-crop.png",
		Now:            at,
	})
}

func TestGoldenChangeRecord(t *testing.T) {
	got, err := json.MarshalIndent(fixture(), "", "  ")
	require.NoError(t, err)
	got = append(got, '\n')

	if *update {
		require.NoError(t, os.WriteFile(goldenPath, got, 0o644))
	}
	want, err := os.ReadFile(goldenPath)
	require.NoError(t, err)
	require.JSONEq(t, string(want), string(got))
}

func TestGoldenChangeRecordDecodesStrictly(t *testing.T) {
	raw, err := os.ReadFile(goldenPath)
	require.NoError(t, err)

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var rec Record
	require.NoError(t, dec.Decode(&rec))
	require.Equal(t, Version, rec.Version)
	require.Equal(t, []string{"text", "visual"}, rec.Dimensions())
	require.Equal(t, fixture(), rec)
}

func TestBuildFillsItemRectsAndSections(t *testing.T) {
	rec := fixture()
	require.Len(t, rec.Items, 2)
	require.Equal(t, &geom.Rect{120, 1792, 640, 28}, rec.Items[0].RectBefore)
	require.Equal(t, &geom.Rect{120, 1840, 640, 28}, rec.Items[0].RectAfter)
	// A region's before side is its from box, not its box moved by guesswork.
	require.Equal(t, &geom.Rect{120, 1952, 480, 260}, rec.Items[1].RectBefore)
	require.Equal(t, &geom.Rect{120, 2000, 480, 260}, rec.Items[1].RectAfter)

	require.Equal(t, []SectionRef{{ID: "plans", Name: "Pricing table", How: "both"}, {ID: "testimonials", Name: "Testimonials", How: "ignore"}}, rec.Sections)
	require.Equal(t, "Pricing table", rec.ItemSection(rec.Items[0]))
	require.Equal(t, "Pricing table", rec.ItemSection(rec.Items[1]))
	require.Equal(t, "Tell me when a plan's price changes. Ignore the testimonials.", rec.Monitor.Instructions)
}

func TestBuildWithoutAnAgentAnswer(t *testing.T) {
	rec := Build(BuildInput{
		Monitor: monitor.Config{ID: "m"},
		Verdict: decide.Verdict{Status: decide.StatusNoise},
		Step:    diff.Evidence{Text: &diff.TextEvidence{}},
	})
	raw, err := json.Marshal(rec)
	require.NoError(t, err)
	// Lists are arrays, never null, and the Monitor's missing instructions
	// read as the default the agent would have been given.
	for _, want := range []string{`"items":[]`, `"ignored":[]`, `"why":[]`, `"suppressed_by":[]`, `"sections":[]`, `"agent":null`, `"visual":null`, `"cumulative":null`} {
		require.Contains(t, string(raw), want)
	}
	require.Equal(t, monitor.DefaultInstructions, rec.Monitor.Instructions)
}

func TestGuard(t *testing.T) {
	r1, r2, r3 := geom.Rect{0, 0, 100, 20}, geom.Rect{0, 100, 100, 20}, geom.Rect{200, 100, 50, 20}
	ops := []diff.TextOp{
		{Op: diff.OpModify, Rect: &r2, FromRect: &r1},
		{Op: diff.OpAdd, Rect: &r3},
		{Op: diff.OpRemove, FromRect: &r1},
		{Op: diff.OpIgnored, Rect: &r1, FromRect: &r1},
	}
	band := geom.Rect{0, 300, 400, 48}
	box, from := geom.Rect{10, 500, 40, 40}, geom.Rect{10, 452, 40, 40}
	regions := []diff.Region{
		{Box: box, Kind: diff.RegionChanged, FromBox: &from},
		{Box: band, Kind: diff.RegionInsertedBand},
		{Box: band, Kind: diff.RegionRemovedBand, FromBox: &band},
	}

	items := Guard([]Item{
		{Title: "valid", Kind: ItemText, Ops: []int{0, 1}},
		{Title: "all out of range", Kind: ItemText, Ops: []int{4, -1}, Regions: []int{3, 99}},
		{Title: "cites nothing", Kind: ItemText},
		{Title: "partly out of range", Kind: ItemText, Ops: []int{9, 1, 1}, Regions: []int{7}},
		{Title: "only an ignored op", Kind: ItemText, Ops: []int{3}},
		{Title: "removed text", Kind: ItemText, Ops: []int{2}},
		{Title: "regions", Kind: "picture", Regions: []int{0, 1}},
		{Title: "removed band", Kind: ItemVisual, Regions: []int{2}},
		{Title: "text and region", Kind: ItemText, Ops: []int{1}, Regions: []int{0}},
	}, ops, regions)

	titles := make([]string, len(items))
	for i, it := range items {
		titles[i] = it.Title
	}
	require.Equal(t, []string{"valid", "partly out of range", "removed text", "regions", "removed band", "text and region"}, titles)

	// valid: the union of both cited ops on each side.
	require.Equal(t, []int{0, 1}, items[0].Ops)
	require.Equal(t, []int{}, items[0].Regions, "never null")
	require.Equal(t, &r1, items[0].RectBefore)
	require.Equal(t, &geom.Rect{0, 100, 250, 20}, items[0].RectAfter)

	// partly out of range: the bad indexes and the duplicate are stripped.
	require.Equal(t, []int{1}, items[1].Ops)
	require.Equal(t, []int{}, items[1].Regions)
	require.Nil(t, items[1].RectBefore, "an added block has no before side")
	require.Equal(t, &r3, items[1].RectAfter)

	// removed text is on the before screenshot only.
	require.Equal(t, &r1, items[2].RectBefore)
	require.Nil(t, items[2].RectAfter)

	// regions: an unknown kind is corrected; the inserted band has no before.
	require.Equal(t, ItemVisual, items[3].Kind)
	require.Equal(t, &from, items[3].RectBefore)
	require.Equal(t, &geom.Rect{0, 300, 400, 240}, items[3].RectAfter)

	// a removed band is on the before screenshot only.
	require.Equal(t, &band, items[4].RectBefore)
	require.Nil(t, items[4].RectAfter)

	// text and region together.
	require.Equal(t, &from, items[5].RectBefore)
	require.Equal(t, &geom.Rect{10, 100, 240, 440}, items[5].RectAfter)

	require.Empty(t, Guard(nil, ops, regions))
	require.NotNil(t, Guard(nil, nil, nil))
	require.Empty(t, Guard([]Item{{Title: "no evidence at all", Ops: []int{0}, Regions: []int{0}}}, nil, nil))
}
