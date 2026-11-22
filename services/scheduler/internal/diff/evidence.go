// Package diff holds the types every stage of the pipeline shares: normalized
// blocks (the output of diff/normalize) and the evidence each Comparator
// produces (diff/text, diff/visual). The Comparators live in sub-packages;
// decide and changerecord consume only these types.
//
// The JSON shapes here are part of the Change Record and are mirrored in
// packages/types/src/change-record.ts.
package diff

import (
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// Token is one unit of normalized text. Compare is what the comparator
// matches on (folded quotes and dashes, masked tokens replaced by their
// placeholder); Display is what the user is shown.
type Token struct {
	Display string `json:"display"`
	Compare string `json:"compare"`
	// Mask is the volatile-token class when this token was masked.
	Mask string `json:"mask,omitempty"`
	// Kind is word, number, space, punct, or mask.
	Kind TokenKind `json:"kind"`
}

// TokenKind classifies a token.
type TokenKind string

const (
	TokenWord   TokenKind = "word"
	TokenNumber TokenKind = "number"
	TokenSpace  TokenKind = "space"
	TokenPunct  TokenKind = "punct"
	TokenMask   TokenKind = "mask"
)

// Counts reports whether a token counts as a word for magnitudes: whitespace
// and masked placeholders do not.
func (t Token) Counts() bool { return t.Kind == TokenWord || t.Kind == TokenNumber }

// NBlock is a normalized Capture block.
type NBlock struct {
	ID   string    `json:"id"`
	Path string    `json:"path"`
	Tag  string    `json:"tag"`
	Rect geom.Rect `json:"rect"`
	// Display is the block text as captured, with whitespace collapsed.
	Display string `json:"display"`
	// Compare is the canonical comparison text: the Compare of every token
	// joined together.
	Compare string  `json:"compare"`
	Tokens  []Token `json:"tokens"`
	// Ignored blocks are aligned and shown collapsed, but never count: they
	// lie in a part of the page the Watch Plan does not watch as text.
	Ignored bool `json:"ignored,omitempty"`
	// Masked lists the classes masked inside this block.
	Masked []string `json:"masked,omitempty"`
}

// OpKind names a text op.
type OpKind string

const (
	OpAdd     OpKind = "add"
	OpRemove  OpKind = "remove"
	OpModify  OpKind = "modify"
	OpMove    OpKind = "move"
	OpIgnored OpKind = "ignored"
)

// WordOp is one entry of a modify op's word diff: "=" kept, "-" removed, "+"
// added.
type WordOp struct {
	Op   string `json:"op"`
	Text string `json:"text"`
	Mask string `json:"mask,omitempty"`
}

// TextOp is one entry of the text comparator's ordered op list.
type TextOp struct {
	Op OpKind `json:"op"`
	// BlockID and Rect describe the "after" block; FromBlockID and FromRect
	// the "before" block. A remove has only the from side, an add only the
	// after side.
	BlockID     string     `json:"block_id,omitempty"`
	FromBlockID string     `json:"from_block_id,omitempty"`
	Path        string     `json:"path"`
	Tag         string     `json:"tag,omitempty"`
	Rect        *geom.Rect `json:"rect,omitempty"`
	FromRect    *geom.Rect `json:"from_rect,omitempty"`
	// Text is the display text for add, remove, move and ignored ops.
	Text string `json:"text,omitempty"`
	// OldText is the before text of an ignored modify.
	OldText string `json:"old_text,omitempty"`
	// Tokens is the word diff of a modify op.
	Tokens []WordOp `json:"tokens,omitempty"`
	// Whole marks a modify rendered as a whole-block replacement.
	Whole bool `json:"whole,omitempty"`
	// From and To are block positions (before and after) for move ops.
	From int `json:"from"`
	To   int `json:"to"`
	// ContextBefore and ContextAfter hold up to two neighbouring unchanged
	// blocks on the after side, for changes-only views and notifications.
	ContextBefore []string `json:"context_before,omitempty"`
	ContextAfter  []string `json:"context_after,omitempty"`
	// Masked lists classes masked inside the op's blocks.
	Masked []string `json:"masked,omitempty"`
	// Section is the id of the Watch Plan Section the block lies in, "" when
	// it is outside every Section.
	Section string `json:"section,omitempty"`
}

// Counted reports whether the op can make a Change. Ignored ops cannot.
func (o TextOp) Counted() bool { return o.Op != OpIgnored }

// AddedText returns the text this op added (joined added spans).
func (o TextOp) AddedText() string {
	switch o.Op {
	case OpAdd:
		return o.Text
	case OpModify:
		return joinWordOps(o.Tokens, "+")
	}
	return ""
}

// RemovedText returns the text this op removed.
func (o TextOp) RemovedText() string {
	switch o.Op {
	case OpRemove:
		return o.Text
	case OpModify:
		return joinWordOps(o.Tokens, "-")
	}
	return ""
}

func joinWordOps(ops []WordOp, kind string) string {
	out := ""
	for _, t := range ops {
		if t.Op == kind {
			if out != "" {
				out += " "
			}
			out += t.Text
		}
	}
	return out
}

// TextMagnitude summarizes a text comparison.
type TextMagnitude struct {
	WordsAdded    int     `json:"words_added"`
	WordsRemoved  int     `json:"words_removed"`
	BlocksChanged int     `json:"blocks_changed"`
	Moves         int     `json:"moves"`
	ChangeRatio   float64 `json:"change_ratio"`
	NetAdded      int     `json:"net_added"`
	NetRemoved    int     `json:"net_removed"`
}

// TextEvidence is the text comparator's output.
type TextEvidence struct {
	Ops          []TextOp      `json:"ops"`
	Magnitude    TextMagnitude `json:"magnitude"`
	IgnoredCount int           `json:"ignored_count"`
	// Masked lists every volatile-token class masked on either side.
	Masked []string `json:"masked,omitempty"`
}

// CountedOps returns the ops that can make a Change.
func (e *TextEvidence) CountedOps() []TextOp {
	if e == nil {
		return nil
	}
	out := make([]TextOp, 0, len(e.Ops))
	for _, op := range e.Ops {
		if op.Counted() {
			out = append(out, op)
		}
	}
	return out
}

// HasIgnored reports whether any ignored op exists.
func (e *TextEvidence) HasIgnored() bool {
	if e == nil {
		return false
	}
	for _, op := range e.Ops {
		if op.Op == OpIgnored {
			return true
		}
	}
	return false
}

// Region kinds.
const (
	RegionChanged      = "changed"
	RegionInsertedBand = "inserted_band"
	RegionRemovedBand  = "removed_band"
	RegionExtraWidth   = "extra_width"
)

// Region is one box of visual change. Box is in "after" screenshot
// coordinates, except for an area that exists on the before side only (a
// removed band, or the extra width of a wider before screenshot), which is
// reported at the "before" coordinates it occupied.
type Region struct {
	Box    geom.Rect `json:"box"`
	Kind   string    `json:"kind"`
	Pixels int       `json:"pixels"`
	Blocks []string  `json:"blocks,omitempty"`
	// FromBox is where the same area lies on the before screenshot, which
	// differs from Box whenever content above it moved. Nil when the area
	// exists on the after side only.
	FromBox *geom.Rect `json:"from_box,omitempty"`
	// Section is the id of the Watch Plan Section the region was found in,
	// "" outside every Section and without a plan.
	Section string `json:"section,omitempty"`
}

// BeforeOnly reports whether the region exists on the before screenshot
// only, so Box is in before coordinates.
func (r Region) BeforeOnly() bool {
	return r.Kind == RegionRemovedBand || (r.Kind == RegionExtraWidth && r.FromBox != nil)
}

// RectBefore is where the region lies on the before screenshot, or nil.
func (r Region) RectBefore() *geom.Rect { return r.FromBox }

// RectAfter is where the region lies on the after screenshot, or nil.
func (r Region) RectAfter() *geom.Rect {
	if r.BeforeOnly() {
		return nil
	}
	box := r.Box
	return &box
}

// Shift is a vertical offset explaining at least 30% of the rows.
type Shift struct {
	FromY int `json:"from_y"`
	DY    int `json:"dy"`
}

// VisualEvidence is the visual comparator's output.
type VisualEvidence struct {
	Regions        []Region `json:"regions"`
	Shift          *Shift   `json:"shift"`
	AreaRatio      float64  `json:"area_ratio"`
	ChangedPixels  int      `json:"changed_pixels"`
	UnmaskedPixels int      `json:"unmasked_pixels"`
	SizeBefore     [2]int   `json:"size_before"`
	SizeAfter      [2]int   `json:"size_after"`
}

// Evidence bundles every Comparator's output for one pair of Captures.
// A nil part means that Comparator did not run.
type Evidence struct {
	Text   *TextEvidence   `json:"text"`
	Visual *VisualEvidence `json:"visual"`
}

// Counted is the number of text ops and regions that can make a Change. No
// Change is ever recorded without Counted() > 0, and the agent is only asked
// when it is.
func (e Evidence) Counted() int {
	n := len(e.Text.CountedOps())
	if e.Visual != nil {
		n += len(e.Visual.Regions)
	}
	return n
}
