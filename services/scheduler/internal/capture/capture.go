// Package capture holds the Capture v3 contract the browser worker publishes
// (the Capture type in packages/types/src/protocol.ts), its validation, and
// the fingerprints the scheduler derives from it.
package capture

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// Version is the Capture schema version this package understands.
const Version = 3

// Capture statuses.
const (
	StatusOK      = "ok"
	StatusInvalid = "invalid"
	StatusError   = "error"
)

// Invalid reasons. ReasonPartial is set by the scheduler, because it needs
// the baseline; the browser worker sends the others.
const (
	ReasonHTTPStatus      = "http_status"
	ReasonChallenge       = "challenge"
	ReasonEmpty           = "empty"
	ReasonBlankScreenshot = "blank_screenshot"
	ReasonCrossDomain     = "cross_domain"
	// ReasonMacroFailed: a Macro step failed and could not be repaired, so
	// the page never reached the state the owner wants watched.
	ReasonMacroFailed = "macro_failed"
	ReasonPartial     = "partial"
)

// workerReasons are the invalid reasons the browser worker may send.
var workerReasons = []string{
	ReasonHTTPStatus, ReasonChallenge, ReasonEmpty, ReasonBlankScreenshot, ReasonCrossDomain, ReasonMacroFailed,
}

// Macro replay outcomes.
const (
	MacroOK       = "ok"
	MacroRepaired = "repaired"
	MacroFailed   = "failed"
)

// Caps on what one Capture may carry.
const (
	MaxBlocks     = 5000
	MaxBlockChars = 200_000
)

// Block is one visible block-level element of the rendered page.
type Block struct {
	ID   string    `json:"id"`
	Path string    `json:"path"`
	Tag  string    `json:"tag"`
	Text string    `json:"text"`
	Rect geom.Rect `json:"rect"`
}

// Screenshot points at the image the browser worker uploaded. The bytes never
// travel over AMQP.
type Screenshot struct {
	Key    string `json:"key"`
	W      int    `json:"w"`
	H      int    `json:"h"`
	Format string `json:"format"`
}

// Timings are the browser worker's phase durations in milliseconds.
type Timings struct {
	Load   int `json:"load"`
	Settle int `json:"settle"`
	Total  int `json:"total"`
}

// Meta is what the browser worker observed about the page load.
type Meta struct {
	HTTPStatus int    `json:"http_status"`
	FinalURL   string `json:"final_url"`
	Title      string `json:"title"`
	Stable     bool   `json:"stable"`
	// NetworkQuiet: the network went quiet before its cap.
	NetworkQuiet bool    `json:"network_quiet"`
	EnvVersion   string  `json:"env_version"`
	TimingsMS    Timings `json:"timings_ms"`
}

// Error describes a Capture that could not be taken at all.
type Error struct {
	Message string `json:"message"`
}

// MacroResult says how the Macro replay went.
type MacroResult struct {
	// MacroID is the version the job asked for.
	MacroID string `json:"macro_id"`
	// Status is ok, repaired or failed.
	Status string `json:"status"`
	// FailedStep is the index of the step that failed and could not be
	// repaired.
	FailedStep *int `json:"failed_step"`
	// RepairedMacroID is the new active version the worker inserted when
	// Status is repaired. Later Runs replay it.
	RepairedMacroID *string `json:"repaired_macro_id"`
	// InputTokens and OutputTokens are the model usage of the repair, zero
	// when none was needed.
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Effective is the Macro version the Capture reflects from now on: the
// repaired one after a repair, else the one that was replayed.
func (m *MacroResult) Effective() *string {
	if m == nil {
		return nil
	}
	if m.Status == MacroRepaired && m.RepairedMacroID != nil && *m.RepairedMacroID != "" {
		return m.RepairedMacroID
	}
	return &m.MacroID
}

// Capture is the browser worker's output for one Run (Capture v3).
type Capture struct {
	Version       int         `json:"version"`
	RunID         string      `json:"run_id"`
	MonitorID     string      `json:"monitor_id"`
	Status        string      `json:"status"`
	InvalidReason *string     `json:"invalid_reason"`
	Error         *Error      `json:"error"`
	Blocks        []Block     `json:"blocks"`
	Truncated     bool        `json:"truncated"`
	Screenshot    *Screenshot `json:"screenshot"`
	// Masks are the regions the worker saw animating between two frames.
	Masks []geom.Rect `json:"masks"`
	Meta  Meta        `json:"meta"`
	// Macro is nil when the job had no Macro.
	Macro *MacroResult `json:"macro"`
}

// Decode parses a Capture v3 body strictly: unknown fields are an error, so
// drift between the TypeScript producer and this type fails loudly.
func Decode(body []byte) (Capture, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var c Capture
	if err := dec.Decode(&c); err != nil {
		return Capture{}, fmt.Errorf("decode capture: %w", err)
	}
	if err := c.Validate(); err != nil {
		return Capture{}, err
	}
	return c, nil
}

// Validate checks the structural invariants of a Capture.
func (c Capture) Validate() error {
	if c.Version != Version {
		return fmt.Errorf("capture version %d is not %d", c.Version, Version)
	}
	if c.RunID == "" || c.MonitorID == "" {
		return fmt.Errorf("capture is missing run_id or monitor_id")
	}
	switch c.Status {
	case StatusOK:
	case StatusInvalid:
		if c.InvalidReason == nil || *c.InvalidReason == "" {
			return fmt.Errorf("invalid capture has no invalid_reason")
		}
		if !slices.Contains(workerReasons, *c.InvalidReason) {
			return fmt.Errorf("unknown invalid_reason %q", *c.InvalidReason)
		}
	case StatusError:
		if c.Error == nil || c.Error.Message == "" {
			return fmt.Errorf("error capture has no error message")
		}
	default:
		return fmt.Errorf("unknown capture status %q", c.Status)
	}
	if m := c.Macro; m != nil {
		if m.MacroID == "" {
			return fmt.Errorf("capture macro result has no macro_id")
		}
		switch m.Status {
		case MacroOK, MacroRepaired, MacroFailed:
		default:
			return fmt.Errorf("unknown macro status %q", m.Status)
		}
	}
	if len(c.Blocks) > MaxBlocks {
		return fmt.Errorf("capture has %d blocks, over the %d cap", len(c.Blocks), MaxBlocks)
	}
	seen := make(map[string]struct{}, len(c.Blocks))
	for _, b := range c.Blocks {
		if b.ID == "" {
			return fmt.Errorf("capture has a block without an id")
		}
		if _, dup := seen[b.ID]; dup {
			return fmt.Errorf("capture has duplicate block id %q", b.ID)
		}
		seen[b.ID] = struct{}{}
	}
	return nil
}

// Valid reports whether the Capture may be compared.
func (c Capture) Valid() bool { return c.Status == StatusOK }

// Reason returns the invalid reason, or "" when there is none.
func (c Capture) Reason() string {
	if c.InvalidReason == nil {
		return ""
	}
	return *c.InvalidReason
}

// TextLength is the total length of the block text, used by the partial-load
// check.
func (c Capture) TextLength() int {
	n := 0
	for _, b := range c.Blocks {
		n += len(b.Text)
	}
	return n
}

// StoredBlocks is the `blocks.json.gz` document written to object storage
// for each Capture. It keeps the raw blocks, so both sides of a comparison
// are normalized the same way whenever they are compared, and the agent can
// read more of either page's text.
type StoredBlocks struct {
	Version   int         `json:"version"`
	Blocks    []Block     `json:"blocks"`
	Truncated bool        `json:"truncated"`
	Masks     []geom.Rect `json:"masks,omitempty"`
}
