package text

import (
	"strings"
	"unicode/utf8"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// wholeBlockThreshold is the share of counted tokens that must stay equal for
// a modify to be rendered as a word diff; below it the pair is shown as a
// whole-block replacement.
const wholeBlockThreshold = 0.3

// wordDiff is the token-level diff of one modify pair.
type wordDiff struct {
	Ops     []diff.WordOp
	Whole   bool
	Added   int // counted tokens inserted
	Removed int // counted tokens deleted
}

// diffTokens diffs two token lists by Compare text. Each distinct Compare is
// encoded as one rune so diff-match-patch works at token granularity, then
// DiffCleanupSemantic folds coincidental short equalities into the edits.
// Output text is each token's Display.
//
// Magnitudes and the whole-block decision come from the minimal diff, before
// cleanup: cleanup is for readability, and folding an unchanged "team" into
// an edit must not count it as removed and re-added (which would make two
// one-word edits look like four changed words).
func diffTokens(before, after []diff.Token, oldDisplay, newDisplay string) wordDiff {
	enc := map[string]int{}
	encode := func(toks []diff.Token) []rune {
		out := make([]rune, len(toks))
		for i, t := range toks {
			idx, ok := enc[t.Compare]
			if !ok {
				idx = len(enc)
				enc[t.Compare] = idx
			}
			out[i] = tokenIndexToRune(idx)
		}
		return out
	}
	r1, r2 := encode(before), encode(after)

	dmp := diffmatchpatch.New()
	minimal := dmp.DiffMainRunes(r1, r2, false)
	diffs := dmp.DiffCleanupSemantic(append([]diffmatchpatch.Diff(nil), minimal...))

	var (
		wd                 wordDiff
		ops                []diff.WordOp
		ia, ib             int
		equalCounted       int
		equalAll           int
		countedA, countedB = diff.WordCount(before), diff.WordCount(after)
	)
	// Adjacent unmasked tokens with the same op merge into one entry; the
	// pending entry's text accumulates in buf.
	var buf strings.Builder
	flush := func() {
		if n := len(ops); n > 0 && ops[n-1].Mask == "" {
			ops[n-1].Text = buf.String()
		}
		buf.Reset()
	}
	emit := func(op string, t diff.Token) {
		if n := len(ops); n > 0 && t.Mask == "" && ops[n-1].Op == op && ops[n-1].Mask == "" {
			buf.WriteString(t.Display)
			return
		}
		flush()
		ops = append(ops, diff.WordOp{Op: op, Text: t.Display, Mask: t.Mask})
		buf.WriteString(t.Display)
	}
	for _, d := range diffs {
		n := utf8.RuneCountInString(d.Text)
		for k := 0; k < n; k++ {
			switch d.Type {
			case diffmatchpatch.DiffEqual:
				emit("=", after[ib])
				ia++
				ib++
			case diffmatchpatch.DiffDelete:
				emit("-", before[ia])
				ia++
			case diffmatchpatch.DiffInsert:
				emit("+", after[ib])
				ib++
			}
		}
	}

	flush()

	// Count on the minimal diff.
	ia, ib = 0, 0
	for _, d := range minimal {
		n := utf8.RuneCountInString(d.Text)
		for k := 0; k < n; k++ {
			switch d.Type {
			case diffmatchpatch.DiffEqual:
				equalAll++
				if after[ib].Counts() {
					equalCounted++
				}
				ia++
				ib++
			case diffmatchpatch.DiffDelete:
				if before[ia].Counts() {
					wd.Removed++
				}
				ia++
			case diffmatchpatch.DiffInsert:
				if after[ib].Counts() {
					wd.Added++
				}
				ib++
			}
		}
	}

	var ratio float64
	if denom := max(countedA, countedB); denom > 0 {
		ratio = float64(equalCounted) / float64(denom)
	} else if denom := max(len(before), len(after)); denom > 0 {
		ratio = float64(equalAll) / float64(denom)
	}
	if ratio < wholeBlockThreshold {
		wd.Whole = true
		ops = []diff.WordOp{{Op: "-", Text: oldDisplay}, {Op: "+", Text: newDisplay}}
	}
	wd.Ops = ops
	return wd
}

// tokenIndexToRune maps a token index to a valid, non-surrogate rune. The
// UTF-16 surrogate block (U+D800–U+DFFF) is invalid in UTF-8, and
// DiffMainRunes would replace such runes with U+FFFD, collapsing distinct
// tokens. Shifting indices at or above 0xD800 up by 0x800 keeps every encoded
// rune valid.
func tokenIndexToRune(i int) rune {
	r := rune(i)
	if r >= 0xD800 {
		r += 0x800
	}
	return r
}
