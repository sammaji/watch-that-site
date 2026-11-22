package monitor

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
	"time"
)

// WatchHow is the kind of watching a Section needs.
type WatchHow string

const (
	// HowText: the words matter. The text Comparator counts them.
	HowText WatchHow = "text"
	// HowVisual: how it looks matters. The visual Comparator compares the
	// Section crop against crop; its words are recorded but never count.
	HowVisual WatchHow = "visual"
	// HowBoth: words and looks.
	HowBoth WatchHow = "both"
	// HowIgnore: the owner does not care. Differences are recorded as ignored
	// and never reach the model.
	HowIgnore WatchHow = "ignore"
)

// Valid reports whether h is one of the four how values.
func (h WatchHow) Valid() bool {
	return h == HowText || h == HowVisual || h == HowBoth || h == HowIgnore
}

// Text reports whether words count under h.
func (h WatchHow) Text() bool { return h == HowText || h == HowBoth }

// Visual reports whether looks count under h.
func (h WatchHow) Visual() bool { return h == HowVisual || h == HowBoth }

// WatchPlanVersion is the Watch Plan schema version.
const WatchPlanVersion = 1

// MaxSections is the most Sections a plan may hold.
const MaxSections = 24

// WatchSection is a named part of the page and how it is watched.
type WatchSection struct {
	// ID is a short slug, kept across re-plans when the Section is the same.
	ID string `json:"id"`
	// Name is what a person would call it: "Pricing table".
	Name string   `json:"name"`
	How  WatchHow `json:"how"`
	// Why is one sentence for the owner on why it is watched this way.
	Why string `json:"why"`
	// Paths are the block paths (absolute XPaths) that root the Section. A
	// block belongs to it when its path equals one of them or lies under it.
	Paths []string `json:"paths"`
}

// WatchPlan is how the Agent decided a Monitor's page should be watched: the
// page divided into Sections. It mirrors WatchPlan in
// packages/types/src/watch-plan.ts and is stored in monitors.watch_plan. A
// nil plan means the whole page is watched as text and visual.
type WatchPlan struct {
	Version  int            `json:"version"`
	Sections []WatchSection `json:"sections"`
	// Rest is how everything outside the Sections is watched.
	Rest    WatchHow `json:"rest"`
	Summary string   `json:"summary"`
	// WaitMS is how long the Agent decided to wait before each Capture, for
	// a page that keeps filling in after it loads. Saved to the Monitor's
	// extra_wait_ms along with the plan.
	WaitMS int `json:"wait_ms,omitempty"`
	// InstructionsHash is InstructionsHash of the instructions the plan was
	// made for.
	InstructionsHash string `json:"instructions_hash"`
	// RunID is the Run whose Capture the Agent looked at.
	RunID string `json:"run_id"`
	// Model made the plan; "" when a person edited it last.
	Model     string    `json:"model"`
	CreatedAt time.Time `json:"created_at"`
}

// InstructionsHash is the sha256 hex of a Monitor's instructions exactly as
// stored. A plan whose hash differs was made for other instructions.
func InstructionsHash(instructions string) string {
	sum := sha256.Sum256([]byte(instructions))
	return hex.EncodeToString(sum[:])
}

// PathUnder reports whether path equals root or lies under it, respecting
// path segments: /html/body/div[1] does not cover /html/body/div[10].
func PathUnder(path, root string) bool {
	return path == root ||
		(len(path) > len(root) && path[:len(root)] == root && path[len(root)] == '/')
}

// SectionFor returns the Section a block path belongs to: the one with the
// longest matching root, or nil when the block is outside every Section (or
// there is no plan).
func (p *WatchPlan) SectionFor(path string) *WatchSection {
	if p == nil {
		return nil
	}
	var best *WatchSection
	bestLen := -1
	for i := range p.Sections {
		for _, root := range p.Sections[i].Paths {
			if len(root) > bestLen && PathUnder(path, root) {
				best, bestLen = &p.Sections[i], len(root)
			}
		}
	}
	return best
}

// SectionID is the id of the Section path belongs to, or "".
func (p *WatchPlan) SectionID(path string) string {
	if s := p.SectionFor(path); s != nil {
		return s.ID
	}
	return ""
}

// HowFor says how a block path is watched: as its Section says, as `rest`
// outside every Section, and as both without a plan. A how value this code
// does not know is read as both, so a bad edit can only widen what is
// watched.
func (p *WatchPlan) HowFor(path string) WatchHow {
	if p == nil {
		return HowBoth
	}
	how := p.Rest
	if s := p.SectionFor(path); s != nil {
		how = s.How
	}
	if !how.Valid() {
		return HowBoth
	}
	return how
}

// RestHow is how everything outside the Sections is watched.
func (p *WatchPlan) RestHow() WatchHow {
	if p == nil || !p.Rest.Valid() {
		return HowBoth
	}
	return p.Rest
}

// matches reports whether any of the block paths lies in the Section.
func (s WatchSection) matches(blockPaths []string) bool {
	for _, root := range s.Paths {
		for _, path := range blockPaths {
			if PathUnder(path, root) {
				return true
			}
		}
	}
	return false
}

// Stale reports whether the plan no longer fits a Capture with the given
// block paths: a Section that is watched matches nothing on the page. An
// ignored Section that went away is no loss, so it does not count.
func (p *WatchPlan) Stale(blockPaths []string) bool {
	if p == nil {
		return false
	}
	for _, s := range p.Sections {
		if s.How != HowIgnore && !s.matches(blockPaths) {
			return true
		}
	}
	return false
}

// GuardSections checks the Sections an agent proposed against the Capture
// they were planned from, whose block paths are given. It drops a Section
// that has no id, repeats an earlier id, has a how value that is not one of
// the four, or whose paths match no block of the Capture; it tidies the paths
// of the rest and keeps at most MaxSections. It never returns nil.
func GuardSections(sections []WatchSection, blockPaths []string) []WatchSection {
	out := make([]WatchSection, 0, len(sections))
	seen := map[string]bool{}
	for _, s := range sections {
		if len(out) == MaxSections {
			break
		}
		s.ID = strings.TrimSpace(s.ID)
		if s.ID == "" || seen[s.ID] || !s.How.Valid() {
			continue
		}
		paths := make([]string, 0, len(s.Paths))
		for _, p := range s.Paths {
			p = strings.TrimSpace(p)
			if p != "/" {
				p = strings.TrimRight(p, "/")
			}
			if p != "" && !slices.Contains(paths, p) {
				paths = append(paths, p)
			}
		}
		s.Paths = paths
		if !s.matches(blockPaths) {
			continue
		}
		if s.Name = strings.TrimSpace(s.Name); s.Name == "" {
			s.Name = s.ID
		}
		seen[s.ID] = true
		out = append(out, s)
	}
	return out
}
