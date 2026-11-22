// Package changerecord builds the Change Record: the one versioned object
// that the web viewer, every notification renderer and the webhook payload
// read. It holds the agent's answer (summary, items, what it ignored) and
// the evidence under it (the text diff and the changed screenshot regions).
// It is mirrored in packages/types/src/change-record.ts; the golden fixture
// in testdata/change_record.json is checked on both sides so the two cannot
// drift.
package changerecord

import (
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// Version is the Change Record schema version.
const Version = 2

// MonitorRef identifies the Monitor.
type MonitorRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
	// Instructions are the Monitor's instructions when the Change was
	// recorded, as the agent was given them.
	Instructions string `json:"instructions"`
}

// RunRef identifies one side of the comparison.
type RunRef struct {
	RunID string    `json:"run_id"`
	At    time.Time `json:"at"`
	// Screenshot is the object key of the Capture's screenshot, or "".
	Screenshot string `json:"screenshot"`
	// Blocks is the object key of the Capture's blocks.json.gz.
	Blocks string `json:"blocks"`
}

// Magnitude merges the text and visual magnitudes.
type Magnitude struct {
	WordsAdded    int     `json:"words_added"`
	WordsRemoved  int     `json:"words_removed"`
	BlocksChanged int     `json:"blocks_changed"`
	Moves         int     `json:"moves"`
	ChangeRatio   float64 `json:"change_ratio"`
	NetAdded      int     `json:"net_added"`
	NetRemoved    int     `json:"net_removed"`
	AreaRatio     float64 `json:"area_ratio"`
}

// TextSection is the text evidence.
type TextSection struct {
	Ops          []diff.TextOp `json:"ops"`
	IgnoredCount int           `json:"ignored_count"`
	Masked       []string      `json:"masked"`
}

// VisualSection is the visual evidence plus the images rendered from it.
type VisualSection struct {
	Regions    []diff.Region `json:"regions"`
	Shift      *diff.Shift   `json:"shift"`
	AreaRatio  float64       `json:"area_ratio"`
	SizeBefore [2]int        `json:"size_before"`
	SizeAfter  [2]int        `json:"size_after"`
	// DiffImage and Crop are object keys, "" when not rendered.
	DiffImage string `json:"diff_image"`
	Crop      string `json:"crop"`
}

// Item kinds.
const (
	ItemText   = "text"
	ItemVisual = "visual"
)

// Item is one thing the agent reports as changed. It points at the evidence
// that shows it: indexes into Text.Ops and Visual.Regions. An item with no
// valid evidence is dropped before the record is stored (see Guard).
type Item struct {
	// Title is a short label: "Enterprise price raised".
	Title string `json:"title"`
	// Before is what it said or looked like before; "" when it is new.
	Before string `json:"before"`
	// After is what it says or looks like now; "" when it was removed.
	After string `json:"after"`
	Kind  string `json:"kind"`
	// Matches names the part of the instructions this matches.
	Matches string `json:"matches"`
	Ops     []int  `json:"ops"`
	Regions []int  `json:"regions"`
	// RectBefore and RectAfter are where it is on each screenshot, so the
	// viewer can show the right part of each.
	RectBefore *geom.Rect `json:"rect_before"`
	RectAfter  *geom.Rect `json:"rect_after"`
}

// Ignored is a difference the agent saw and left out, and why.
type Ignored struct {
	Note   string `json:"note"`
	Reason string `json:"reason"`
}

// Importance levels.
const (
	ImportanceHigh   = "high"
	ImportanceMedium = "medium"
	ImportanceLow    = "low"
)

// AgentVerdict is how the agent reached its answer.
type AgentVerdict struct {
	// Relevant is false when the difference does not match the Monitor's
	// instructions.
	Relevant   bool   `json:"relevant"`
	Importance string `json:"importance"`
	Model      string `json:"model"`
	// Unavailable is true when the model could not be reached; the Change is
	// then sent as it is.
	Unavailable  bool   `json:"unavailable"`
	Error        string `json:"error"`
	InputTokens  int    `json:"input_tokens"`
	OutputTokens int    `json:"output_tokens"`
	// Steps is the number of model turns taken.
	Steps int `json:"steps"`
}

// SectionRef names one Section of the Watch Plan the Change was recorded
// under, so text ops and regions (which carry Section ids) can be grouped
// and labelled.
type SectionRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	How  string `json:"how"`
}

// Cumulative is the text evidence from the last notified Capture to this
// one, present only when that Capture is not the one this Change was
// compared with. Notifications that fall back to the diff render it, so a
// Change raised after several suppressed steps shows everything since the
// owner last heard from us.
type Cumulative struct {
	From      RunRef       `json:"from"`
	Text      *TextSection `json:"text"`
	Magnitude Magnitude    `json:"magnitude"`
}

// Record is the Change Record.
type Record struct {
	Version int           `json:"version"`
	ID      string        `json:"id"`
	Monitor MonitorRef    `json:"monitor"`
	From    RunRef        `json:"from"`
	To      RunRef        `json:"to"`
	Status  decide.Status `json:"status"`
	// Summary is the agent's one-sentence answer, or a sentence built from
	// the evidence when the agent was not asked.
	Summary      string         `json:"summary"`
	Items        []Item         `json:"items"`
	Ignored      []Ignored      `json:"ignored"`
	Why          []decide.Why   `json:"why"`
	SuppressedBy []string       `json:"suppressed_by"`
	Magnitude    Magnitude      `json:"magnitude"`
	Text         *TextSection   `json:"text"`
	Visual       *VisualSection `json:"visual"`
	Agent        *AgentVerdict  `json:"agent"`
	// Sections lists the Watch Plan's Sections; empty without a plan.
	Sections   []SectionRef `json:"sections"`
	Cumulative *Cumulative  `json:"cumulative"`
	CreatedAt  time.Time    `json:"created_at"`
}

// Dimensions lists which kinds of evidence carry counted differences, for
// changes.dimensions.
func (r Record) Dimensions() []string {
	var out []string
	if r.Text != nil && countedText(r.Text.Ops) > 0 {
		out = append(out, "text")
	}
	if r.Visual != nil && len(r.Visual.Regions) > 0 {
		out = append(out, "visual")
	}
	return out
}

func countedText(ops []diff.TextOp) int {
	n := 0
	for _, op := range ops {
		if op.Counted() {
			n++
		}
	}
	return n
}

// NotifyText returns the text evidence a notification without items should
// render: the cumulative one when present, else the step one.
func (r Record) NotifyText() *TextSection {
	if r.Cumulative != nil && r.Cumulative.Text != nil {
		return r.Cumulative.Text
	}
	return r.Text
}

// SectionName is the name of the Section with the given id, or "".
func (r Record) SectionName(id string) string {
	if id == "" {
		return ""
	}
	for _, s := range r.Sections {
		if s.ID == id {
			return s.Name
		}
	}
	return ""
}

// ItemSection is the name of the Section an item's evidence lies in: that
// of the first op or region it cites that is inside one. "" when it is
// outside every Section.
func (r Record) ItemSection(it Item) string {
	if r.Text != nil {
		for _, i := range it.Ops {
			if i >= 0 && i < len(r.Text.Ops) {
				if name := r.SectionName(r.Text.Ops[i].Section); name != "" {
					return name
				}
			}
		}
	}
	if r.Visual != nil {
		for _, i := range it.Regions {
			if i >= 0 && i < len(r.Visual.Regions) {
				if name := r.SectionName(r.Visual.Regions[i].Section); name != "" {
					return name
				}
			}
		}
	}
	return ""
}
