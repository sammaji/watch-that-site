// Package text is the text Comparator. It aligns two lists of
// normalized blocks with patience anchoring (Myers inside gaps without unique
// anchors), pairs leftover deletes and inserts into modifies by word
// similarity, detects moves, word-diffs every modify, and reports the ordered
// op list with its magnitudes.
package text

import (
	"sort"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// contextBlocks is how many unchanged neighbours each op carries per side.
const contextBlocks = 2

// hashKey identifies a block for alignment. The ignored flag is part of the
// key so a block whose ignored status flipped is a changed pair (rendered as
// an ignored op) rather than an equal one.
type hashKey struct {
	compare string
	ignored bool
}

// Compare aligns the before blocks a with the after blocks b and returns the
// text evidence. It never returns nil; identical inputs yield an empty
// (non-nil) op list.
func Compare(a, b []diff.NBlock) *diff.TextEvidence {
	ev := &diff.TextEvidence{Ops: []diff.TextOp{}, Masked: maskedClasses(a, b)}

	ids := map[hashKey]int{}
	hash := func(blocks []diff.NBlock) []int {
		out := make([]int, len(blocks))
		for i, blk := range blocks {
			k := hashKey{blk.Compare, blk.Ignored}
			id, ok := ids[k]
			if !ok {
				id = len(ids)
				ids[k] = id
			}
			out[i] = id
		}
		return out
	}
	ha, hb := hash(a), hash(b)
	if equalInts(ha, hb) {
		return ev
	}

	c := &comparison{a: a, b: b, ha: ha, hb: hb, ws: newWordSets()}
	c.run(align(ha, hb, len(ids)))
	c.emit(ev)
	return ev
}

// side records what happened to one block.
type side uint8

const (
	sideNone   side = iota // removed (a) or added (b)
	sideEqual              // matched to an identical block
	sidePaired             // paired as a modify (or ignored modify)
	sideMoved              // matched to an identical block out of order
)

// comparison holds the state of one Compare call.
type comparison struct {
	a, b   []diff.NBlock
	ha, hb []int
	ws     *wordSets

	stateA, stateB []side
	// partnerA[i] is the b position a[i] maps to (equal, paired or moved),
	// or -1; partnerB likewise.
	partnerA, partnerB []int
}

// run fills the per-block states: equal matches, then moves, then pairs.
func (c *comparison) run(matches []match) {
	na, nb := len(c.a), len(c.b)
	c.stateA, c.stateB = make([]side, na), make([]side, nb)
	c.partnerA, c.partnerB = fill(na, -1), fill(nb, -1)
	for _, m := range matches {
		c.link(m.I, m.J, sideEqual)
	}

	// Moves: an unmatched before block whose hash equals an unmatched after
	// block anywhere. Occurrences of a hash are paired in document order.
	pendingB := map[int][]int{}
	for j := range c.b {
		if c.stateB[j] == sideNone {
			pendingB[c.hb[j]] = append(pendingB[c.hb[j]], j)
		}
	}
	for i := range c.a {
		if c.stateA[i] != sideNone {
			continue
		}
		if q := pendingB[c.ha[i]]; len(q) > 0 {
			c.link(i, q[0], sideMoved)
			pendingB[c.ha[i]] = q[1:]
		}
	}

	// Gaps between consecutive equal matches: pair what is still left.
	pa, pb := 0, 0
	for _, m := range append(matches, match{na, nb}) {
		var dels, ins []int
		for i := pa; i < m.I; i++ {
			if c.stateA[i] == sideNone {
				dels = append(dels, i)
			}
		}
		for j := pb; j < m.J; j++ {
			if c.stateB[j] == sideNone {
				ins = append(ins, j)
			}
		}
		for _, p := range pairGap(c.a, c.b, dels, ins, c.ws) {
			c.link(dels[p[0]], ins[p[1]], sidePaired)
		}
		pa, pb = m.I+1, m.J+1
	}
}

func (c *comparison) link(i, j int, s side) {
	c.stateA[i], c.stateB[j] = s, s
	c.partnerA[i], c.partnerB[j] = j, i
}

// keyedOp is an op with its position in the after document.
type keyedOp struct {
	op  diff.TextOp
	key float64 // after position; removes sit between after blocks (x.5)
	sub int     // tie-break: before position of removes
}

// emit builds the ordered op list, context and magnitudes.
func (c *comparison) emit(ev *diff.TextEvidence) {
	var (
		ops []keyedOp
		mag diff.TextMagnitude
	)

	for j, blk := range c.b {
		switch c.stateB[j] {
		case sideNone:
			op := c.baseOp(-1, j)
			op.Text = blk.Display
			if blk.Ignored {
				op.Op = diff.OpIgnored
			} else {
				op.Op = diff.OpAdd
				mag.WordsAdded += diff.WordCount(blk.Tokens)
				mag.BlocksChanged++
			}
			ops = append(ops, keyedOp{op: op, key: float64(j)})
		case sidePaired:
			i := c.partnerB[j]
			old := c.a[i]
			op := c.baseOp(i, j)
			if old.Ignored || blk.Ignored {
				op.Op = diff.OpIgnored
				op.Text, op.OldText = blk.Display, old.Display
			} else {
				wd := diffTokens(old.Tokens, blk.Tokens, old.Display, blk.Display)
				op.Op = diff.OpModify
				op.Tokens, op.Whole = wd.Ops, wd.Whole
				mag.WordsAdded += wd.Added
				mag.WordsRemoved += wd.Removed
				mag.BlocksChanged++
			}
			ops = append(ops, keyedOp{op: op, key: float64(j)})
		case sideMoved:
			i := c.partnerB[j]
			op := c.baseOp(i, j)
			op.Text = blk.Display
			if blk.Ignored {
				op.Op = diff.OpIgnored
			} else {
				op.Op = diff.OpMove
				op.From, op.To = i, j
				mag.Moves++
			}
			ops = append(ops, keyedOp{op: op, key: float64(j)})
		}
	}

	// A remove sits right after the after-side counterpart of the nearest
	// preceding before block that stayed in place (equal or paired).
	last := -1
	for i, blk := range c.a {
		switch c.stateA[i] {
		case sideEqual, sidePaired:
			last = c.partnerA[i]
			continue
		case sideMoved:
			continue
		}
		op := c.baseOp(i, -1)
		op.Text = blk.Display
		if blk.Ignored {
			op.Op = diff.OpIgnored
		} else {
			op.Op = diff.OpRemove
			mag.WordsRemoved += diff.WordCount(blk.Tokens)
			mag.BlocksChanged++
		}
		ops = append(ops, keyedOp{op: op, key: float64(last) + 0.5, sub: i})
	}

	sort.SliceStable(ops, func(x, y int) bool {
		if ops[x].key != ops[y].key {
			return ops[x].key < ops[y].key
		}
		return ops[x].sub < ops[y].sub
	})

	unchanged := make([]int, 0, len(c.b))
	for j, blk := range c.b {
		if c.stateB[j] == sideEqual && !blk.Ignored {
			unchanged = append(unchanged, j)
		}
	}
	for _, ko := range ops {
		op := ko.op
		op.ContextBefore, op.ContextAfter = c.context(unchanged, ko.key)
		if op.Op == diff.OpIgnored {
			ev.IgnoredCount++
		}
		ev.Ops = append(ev.Ops, op)
	}

	c.magnitudes(&mag)
	ev.Magnitude = mag
}

// baseOp fills the identity fields of an op from the before block a[i] and
// the after block b[j]; either index may be -1.
func (c *comparison) baseOp(i, j int) diff.TextOp {
	var op diff.TextOp
	var masked []string
	if i >= 0 {
		blk := c.a[i]
		op.FromBlockID, op.FromRect = blk.ID, rectPtr(blk.Rect)
		op.Path, op.Tag = blk.Path, blk.Tag
		masked = append(masked, blk.Masked...)
	}
	if j >= 0 {
		blk := c.b[j]
		op.BlockID, op.Rect = blk.ID, rectPtr(blk.Rect)
		op.Path, op.Tag = blk.Path, blk.Tag
		masked = append(masked, blk.Masked...)
	}
	op.Masked = sortedUnique(masked)
	return op
}

// context returns up to contextBlocks unchanged, non-ignored after blocks
// on each side of key, in document order.
func (c *comparison) context(unchanged []int, key float64) (before, after []string) {
	k := sort.Search(len(unchanged), func(n int) bool { return float64(unchanged[n]) >= key })
	for n := max(0, k-contextBlocks); n < k; n++ {
		before = append(before, c.b[unchanged[n]].Display)
	}
	k = sort.Search(len(unchanged), func(n int) bool { return float64(unchanged[n]) > key })
	for n := k; n < len(unchanged) && n < k+contextBlocks; n++ {
		after = append(after, c.b[unchanged[n]].Display)
	}
	return before, after
}

// magnitudes fills change_ratio and the net set counts.
func (c *comparison) magnitudes(mag *diff.TextMagnitude) {
	var wordsBefore, wordsAfter int
	counts := map[string]int{}
	for _, blk := range c.a {
		if !blk.Ignored {
			wordsBefore += diff.WordCount(blk.Tokens)
			counts[blk.Compare]++
		}
	}
	for _, blk := range c.b {
		if !blk.Ignored {
			wordsAfter += diff.WordCount(blk.Tokens)
			counts[blk.Compare]--
		}
	}
	for _, n := range counts {
		if n > 0 {
			mag.NetRemoved += n
		} else {
			mag.NetAdded -= n
		}
	}
	if denom := max(wordsBefore, wordsAfter); denom > 0 {
		mag.ChangeRatio = min(1, float64(mag.WordsAdded+mag.WordsRemoved)/float64(denom))
	}
}

// maskedClasses is the sorted unique set of classes masked on either side.
func maskedClasses(a, b []diff.NBlock) []string {
	var all []string
	for _, blk := range a {
		all = append(all, blk.Masked...)
	}
	for _, blk := range b {
		all = append(all, blk.Masked...)
	}
	return sortedUnique(all)
}

func sortedUnique(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	sort.Strings(s)
	out := s[:1]
	for _, v := range s[1:] {
		if v != out[len(out)-1] {
			out = append(out, v)
		}
	}
	return out
}

// rectPtr returns a pointer to r, or nil when the block has no geometry.
func rectPtr(r geom.Rect) *geom.Rect {
	if r == (geom.Rect{}) {
		return nil
	}
	return &r
}

func fill(n, v int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = v
	}
	return out
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
