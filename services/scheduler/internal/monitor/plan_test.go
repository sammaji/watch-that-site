package monitor

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func plan() *WatchPlan {
	return &WatchPlan{
		Version: WatchPlanVersion,
		Sections: []WatchSection{
			{ID: "main", Name: "Main content", How: HowText, Paths: []string{"/html/body/main"}},
			{ID: "chart", Name: "Price chart", How: HowVisual, Paths: []string{"/html/body/main/div[1]/figure"}},
			{ID: "testimonials", Name: "Testimonials", How: HowIgnore, Paths: []string{"/html/body/main/section[3]", "/html/body/aside"}},
		},
		Rest: HowBoth,
	}
}

func TestPathUnder(t *testing.T) {
	require.True(t, PathUnder("/html/body/div[1]", "/html/body/div[1]"))
	require.True(t, PathUnder("/html/body/div[1]/p[2]", "/html/body/div[1]"))
	require.False(t, PathUnder("/html/body/div[10]", "/html/body/div[1]"), "a sibling index is not a child")
	require.False(t, PathUnder("/html/body", "/html/body/div[1]"), "a parent is not under its child")
}

func TestSectionForPicksTheLongestRoot(t *testing.T) {
	p := plan()
	require.Equal(t, "main", p.SectionFor("/html/body/main/p[1]").ID)
	require.Equal(t, "chart", p.SectionFor("/html/body/main/div[1]/figure/img").ID, "the more specific Section wins")
	require.Equal(t, "testimonials", p.SectionFor("/html/body/main/section[3]/blockquote").ID)
	require.Equal(t, "testimonials", p.SectionFor("/html/body/aside").ID, "a Section may have several roots")
	require.Nil(t, p.SectionFor("/html/body/footer/p"))
	require.Equal(t, "", p.SectionID("/html/body/footer/p"))
	require.Equal(t, "chart", p.SectionID("/html/body/main/div[1]/figure"))
}

func TestHowFor(t *testing.T) {
	p := plan()
	require.Equal(t, HowText, p.HowFor("/html/body/main/p[1]"))
	require.Equal(t, HowVisual, p.HowFor("/html/body/main/div[1]/figure/img"))
	require.Equal(t, HowIgnore, p.HowFor("/html/body/aside/p"))
	require.Equal(t, HowBoth, p.HowFor("/html/body/footer/p"), "outside every Section: as rest says")

	p.Rest = HowIgnore
	require.Equal(t, HowIgnore, p.HowFor("/html/body/footer/p"))

	// No plan: the whole page is watched as both.
	var none *WatchPlan
	require.Nil(t, none.SectionFor("/html/body/main"))
	require.Equal(t, HowBoth, none.HowFor("/html/body/main"))
	require.Equal(t, HowBoth, none.RestHow())
	require.False(t, none.Stale(nil))

	// A how value nobody knows widens to both rather than hiding anything.
	p.Sections[0].How = "sometimes"
	p.Rest = ""
	require.Equal(t, HowBoth, p.HowFor("/html/body/main/p[1]"))
	require.Equal(t, HowBoth, p.HowFor("/html/body/footer/p"))
}

func TestHowKinds(t *testing.T) {
	require.True(t, HowText.Text() && HowBoth.Text())
	require.False(t, HowVisual.Text() || HowIgnore.Text())
	require.True(t, HowVisual.Visual() && HowBoth.Visual())
	require.False(t, HowText.Visual() || HowIgnore.Visual())
	require.False(t, WatchHow("").Valid())
}

func TestStale(t *testing.T) {
	p := plan()
	page := []string{"/html/body/main/p[1]", "/html/body/main/div[1]/figure/img", "/html/body/aside/p"}
	require.False(t, p.Stale(page))

	// The chart went away: a watched Section matches nothing.
	require.True(t, p.Stale([]string{"/html/body/main/p[1]", "/html/body/aside/p"}))
	// An ignored Section going away is no loss.
	require.False(t, p.Stale([]string{"/html/body/main/p[1]", "/html/body/main/div[1]/figure/img"}))
	require.True(t, p.Stale(nil))
}

func TestGuardSections(t *testing.T) {
	page := []string{"/html/body/main/p[1]", "/html/body/main/table/tr[1]/td[1]", "/html/body/footer/p"}
	got := GuardSections([]WatchSection{
		{ID: " prices ", Name: " Pricing table ", How: HowBoth, Why: "Prices.", Paths: []string{" /html/body/main/table/ ", "/html/body/main/table", ""}},
		{ID: "gone", Name: "Not on the page", How: HowText, Paths: []string{"/html/body/nav"}},
		{ID: "odd", Name: "Odd how", How: "sometimes", Paths: []string{"/html/body/main"}},
		{ID: "", Name: "No id", How: HowText, Paths: []string{"/html/body/main"}},
		{ID: "prices", Name: "Same id again", How: HowIgnore, Paths: []string{"/html/body/footer"}},
		{ID: "nopaths", Name: "No paths", How: HowText},
		{ID: "footer", How: HowIgnore, Paths: []string{"/html/body/footer"}},
		{ID: "mixed", Name: "One live path", How: HowText, Paths: []string{"/html/body/nav", "/html/body/main/p[1]"}},
	}, page)

	require.Equal(t, []WatchSection{
		{ID: "prices", Name: "Pricing table", How: HowBoth, Why: "Prices.", Paths: []string{"/html/body/main/table"}},
		{ID: "footer", Name: "footer", How: HowIgnore, Paths: []string{"/html/body/footer"}},
		{ID: "mixed", Name: "One live path", How: HowText, Paths: []string{"/html/body/nav", "/html/body/main/p[1]"}},
	}, got)

	require.NotNil(t, GuardSections(nil, page))
	require.Empty(t, GuardSections([]WatchSection{{ID: "a", How: HowText, Paths: []string{"/html/body/main"}}}, nil), "no blocks: nothing can match")
}

func TestGuardSectionsCapsTheCount(t *testing.T) {
	var sections []WatchSection
	var page []string
	for i := range 40 {
		path := fmt.Sprintf("/html/body/div[%d]", i+1)
		sections = append(sections, WatchSection{ID: fmt.Sprintf("s%d", i), How: HowText, Paths: []string{path}})
		page = append(page, path+"/p")
	}
	got := GuardSections(sections, page)
	require.Len(t, got, MaxSections)
	require.Equal(t, "s0", got[0].ID)
	require.Equal(t, "s23", got[MaxSections-1].ID)
}

func TestInstructionsHash(t *testing.T) {
	// sha256("") and sha256("abc"), hex.
	require.Equal(t, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", InstructionsHash(""))
	require.Equal(t, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", InstructionsHash("abc"))
	require.NotEqual(t, InstructionsHash("Watch prices"), InstructionsHash("Watch prices "), "the instructions are hashed exactly as stored")
}

// The JSON is the WatchPlan of packages/types/src/watch-plan.ts.
func TestWatchPlanJSON(t *testing.T) {
	p := plan()
	p.Summary = "Watching the main content and the chart."
	p.InstructionsHash = InstructionsHash("abc")
	p.RunID = "2136440b-8e77-4a2d-8fe2-fcaea8af11f7"
	p.Model = "gpt-5.1"
	p.CreatedAt = time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)

	raw, err := json.Marshal(p)
	require.NoError(t, err)
	var top map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &top))
	keys := make([]string, 0, len(top))
	for k := range top {
		keys = append(keys, k)
	}
	require.ElementsMatch(t, []string{"version", "sections", "rest", "summary", "instructions_hash", "run_id", "model", "created_at"}, keys)
	require.JSONEq(t, `"2026-11-20T10:00:00Z"`, string(top["created_at"]))
	require.JSONEq(t, `{"id":"chart","name":"Price chart","how":"visual","why":"","paths":["/html/body/main/div[1]/figure"]}`,
		string(mustIndex(t, top["sections"], 1)))

	var back WatchPlan
	require.NoError(t, json.Unmarshal(raw, &back))
	require.Equal(t, *p, back)
}

func mustIndex(t *testing.T, raw json.RawMessage, i int) json.RawMessage {
	t.Helper()
	var list []json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &list))
	return list[i]
}

func TestCaptureVersion(t *testing.T) {
	macroA, macroB := "macro-a", "macro-b"
	base := Config{URL: "https://acme.test/pricing", ViewportW: 1366, ViewportH: 768, BlockAds: true}
	v := base.CaptureVersion()

	// Everything that changes what is captured changes the version.
	for name, change := range map[string]func(*Config){
		"url":        func(c *Config) { c.URL = "https://acme.test/plans" },
		"viewport w": func(c *Config) { c.ViewportW = 1280 },
		"viewport h": func(c *Config) { c.ViewportH = 800 },
		"extra wait": func(c *Config) { c.ExtraWaitMS = 2000 },
		"block ads":  func(c *Config) { c.BlockAds = false },
		"macro":      func(c *Config) { c.ActiveMacroID = &macroA },
	} {
		c := base
		change(&c)
		require.NotEqual(t, v, c.CaptureVersion(), name)
	}

	// What only changes how a Capture is judged does not.
	c := base
	c.Instructions, c.ConfirmChanges, c.WatchPlan, c.Name = "Watch prices", true, plan(), "Renamed"
	model := "gpt-5.1"
	c.Model, c.ConnectionID = &model, &model
	require.Equal(t, v, c.CaptureVersion())

	// The Macro can be given, for a Capture taken with another version than
	// the active one.
	c.ActiveMacroID = &macroA
	require.Equal(t, c.CaptureVersion(), c.CaptureVersionFor(&macroA))
	require.NotEqual(t, c.CaptureVersion(), c.CaptureVersionFor(&macroB))
	require.Equal(t, v, c.CaptureVersionFor(nil))
}

func TestEffectiveInstructions(t *testing.T) {
	require.Equal(t, DefaultInstructions, Config{}.EffectiveInstructions())
	require.Equal(t, DefaultInstructions, Config{Instructions: "  \n"}.EffectiveInstructions())
	require.Equal(t, "Watch prices", Config{Instructions: " Watch prices "}.EffectiveInstructions())
	// The same text as DEFAULT_INSTRUCTIONS in packages/types.
	require.Equal(t, "Tell me about any meaningful change to the content of this page. Ignore dates, counters, ads and rotating content.", DefaultInstructions)
}
