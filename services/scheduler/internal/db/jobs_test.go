package db

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

func keys(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var m map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &m))
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// The job must have exactly the fields of ScrapeJob v3 in
// packages/types/src/protocol.ts: the worker reads nothing else, and nothing
// about scopes, selectors or learning passes is left.
func TestScrapeJobV3Shape(t *testing.T) {
	macro := "5b0c2f0e-3c57-4a55-b1a5-0d6f3f0f7a11"
	cfg := monitor.Config{
		ID: "8dea949d-d40b-49f6-8f9a-9e31f891eb4e", URL: "https://acme.test/billing",
		ViewportW: 1280, ViewportH: 800, ExtraWaitMS: 1500, BlockAds: true,
		ActiveMacroID: &macro,
		// None of these change the job.
		Instructions: "Tell me when the price changes.", ConfirmChanges: true,
		WatchPlan: &monitor.WatchPlan{Rest: monitor.HowText},
	}
	job := BuildScrapeJob(cfg, "2136440b-8e77-4a2d-8fe2-fcaea8af11f7", "2026-11-21.1")

	raw, err := json.Marshal(job)
	require.NoError(t, err)
	require.JSONEq(t, `{
		"version": 3,
		"run_id": "2136440b-8e77-4a2d-8fe2-fcaea8af11f7",
		"monitor_id": "8dea949d-d40b-49f6-8f9a-9e31f891eb4e",
		"url": "https://acme.test/billing",
		"viewport": {"w": 1280, "h": 800},
		"capture": {
			"screenshot": "png", "full_page": true, "max_height": 8000,
			"extra_wait_ms": 1500, "block_ads": true, "block_cookie_banners": true
		},
		"macro_id": "5b0c2f0e-3c57-4a55-b1a5-0d6f3f0f7a11",
		"storage_state_key": null,
		"env_version": "2026-11-21.1"
	}`, string(raw))

	var top map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &top))
	require.ElementsMatch(t, []string{
		"version", "run_id", "monitor_id", "url", "viewport", "capture", "macro_id", "storage_state_key", "env_version",
	}, keys(t, raw))
	require.ElementsMatch(t, []string{
		"screenshot", "full_page", "max_height", "extra_wait_ms", "block_ads", "block_cookie_banners",
	}, keys(t, top["capture"]))
}

func TestScrapeJobWithoutAMacro(t *testing.T) {
	job := BuildScrapeJob(monitor.Config{ID: "m", URL: "https://acme.test"}, "r", "env")

	raw, err := json.Marshal(job)
	require.NoError(t, err)
	var top map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &top))
	require.JSONEq(t, `null`, string(top["macro_id"]), "always present, null without a Macro")
	require.JSONEq(t, `null`, string(top["storage_state_key"]), "every Run starts with a fresh browser")
	// Viewport falls back to the default when the Monitor has none.
	require.JSONEq(t, `{"w":1366,"h":768}`, string(top["viewport"]))
	require.False(t, job.Capture.BlockAds)
	require.False(t, job.Capture.BlockCookieBanners)
}
