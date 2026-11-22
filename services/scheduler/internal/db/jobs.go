package db

import "github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"

// MaxScreenshotHeight caps how tall a full-page screenshot may be.
const MaxScreenshotHeight = 8000

// BuildScrapeJob turns a Monitor's configuration into the browser worker's
// job. The screenshot is always a full-page PNG: the visual Comparator runs
// on every Run, and pixel diffs are only meaningful on lossless images.
//
// Every Run starts with a fresh browser: no storage state key, so no cookies
// or local storage carry over from an earlier Run. The page is seen as a new
// visitor sees it, and a Macro that signs in does so on every Run.
func BuildScrapeJob(cfg monitor.Config, runID string, envVersion string) ScrapeJob {
	return ScrapeJob{
		Version:   ScrapeJobVersion,
		RunID:     runID,
		MonitorID: cfg.ID,
		URL:       cfg.URL,
		Viewport:  Viewport{W: orDefault(cfg.ViewportW, 1366), H: orDefault(cfg.ViewportH, 768)},
		Capture: CaptureOptions{
			Screenshot:         "png",
			FullPage:           true,
			MaxHeight:          MaxScreenshotHeight,
			ExtraWaitMS:        cfg.ExtraWaitMS,
			BlockAds:           cfg.BlockAds,
			BlockCookieBanners: cfg.BlockAds,
		},
		MacroID:         cfg.ActiveMacroID,
		StorageStateKey: nil,
		EnvVersion:      envVersion,
	}
}

func orDefault(v, fallback int) int {
	if v <= 0 {
		return fallback
	}
	return v
}
