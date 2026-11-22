// Package monitor holds a Monitor's configuration as the pipeline reads it: a
// URL, the owner's instructions in plain words, the model the agent uses, and
// how the page is captured. It mirrors the `monitors` table and the Monitor
// type in packages/types/src/monitor-config.ts.
package monitor

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

// Urgency controls when a Change is delivered.
const (
	UrgencyInstant = "instant"
	UrgencyHourly  = "hourly"
	UrgencyDaily   = "daily"
)

// DefaultInstructions is what the agent is told when a Monitor has none. It
// is the same text as DEFAULT_INSTRUCTIONS in
// packages/types/src/monitor-config.ts.
const DefaultInstructions = "Tell me about any meaningful change to the content of this page. Ignore dates, counters, ads and rotating content."

// Config is the part of a Monitor the pipeline needs.
type Config struct {
	ID     string
	UserID string
	Name   string
	URL    string
	// Instructions say what to watch for and what to ignore, in the owner's
	// words. The agent reads them on every Run that finds a difference.
	Instructions string
	// ConnectionID and Model pick the model the agent uses. Without a
	// connection the agent is never asked and every difference is sent.
	ConnectionID *string
	Model        *string
	// ConfirmChanges re-checks a Change on the next Run before alerting.
	ConfirmChanges bool
	// ActiveMacroID is the Macro version replayed before each Capture, if the
	// Monitor has one.
	ActiveMacroID *string
	// WatchPlan divides the page into Sections and says how each is watched.
	// Nil until the first plan is made: the whole page is then watched as
	// text and visual. It is not part of the capture version: both sides of
	// a comparison are evaluated with the current plan.
	WatchPlan   *WatchPlan
	Urgency     string
	ViewportW   int
	ViewportH   int
	ExtraWaitMS int
	BlockAds    bool
	// IntervalMin is 0 for a Monitor that only runs on demand.
	IntervalMin  int
	SnoozedUntil *time.Time
	Status       string
}

// Snoozed reports whether notifications are suppressed at now. Snooze never
// stops Runs; it only holds back Reactions.
func (c Config) Snoozed(now time.Time) bool {
	return c.SnoozedUntil != nil && now.Before(*c.SnoozedUntil)
}

// EffectiveInstructions is what the agent is given: the owner's instructions,
// or DefaultInstructions when they wrote none.
func (c Config) EffectiveInstructions() string {
	if s := strings.TrimSpace(c.Instructions); s != "" {
		return s
	}
	return DefaultInstructions
}

// CaptureVersion hashes every setting that changes what the browser worker
// captures, with the Monitor's active Macro. See CaptureVersionFor.
func (c Config) CaptureVersion() string {
	return c.CaptureVersionFor(c.ActiveMacroID)
}

// CaptureVersionFor hashes every setting that changes what the browser
// worker captures: URL, viewport, extra wait, ad blocking and the Macro that
// was replayed. When the value differs from the one stored in monitor_state,
// the next valid Capture becomes the baseline silently, instead of being
// compared with a Capture taken under different settings.
//
// The Macro is a parameter because the Capture being evaluated may have been
// taken with another version than the one active now (the owner approved a
// new one meanwhile, or the worker repaired it during the Run).
func (c Config) CaptureVersionFor(macroID *string) string {
	macro := ""
	if macroID != nil {
		macro = *macroID
	}
	payload, _ := json.Marshal(struct {
		URL         string
		ViewportW   int
		ViewportH   int
		ExtraWaitMS int
		BlockAds    bool
		MacroID     string
	}{c.URL, c.ViewportW, c.ViewportH, c.ExtraWaitMS, c.BlockAds, macro})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:8])
}
