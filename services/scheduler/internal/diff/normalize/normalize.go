// Package normalize turns Capture blocks into normalized blocks: Unicode
// canonicalization and volatile-token masking (relative times, clocks,
// counters and the like), so two Captures of an unchanged page compare equal.
// Every class of volatile token is always masked; nothing configures it. Both
// Captures of a comparison are normalized with the same Options.
package normalize

import (
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
)

// Options is what Normalize needs besides the blocks.
type Options struct {
	// CaptureDate enables the `today` class for that calendar date. The zero
	// time disables it.
	CaptureDate time.Time
	// Ignore reports whether the block at a path is not watched as text (the
	// Watch Plan ignores it, or watches only how it looks). Such blocks are
	// kept and aligned but never count. Nil ignores nothing.
	Ignore func(path string) bool
}

// Normalize canonicalizes, masks and flags every block. Blocks whose
// canonical text is empty are dropped; order, ID, Path, Tag and Rect are
// preserved.
func Normalize(blocks []capture.Block, opts Options) []diff.NBlock {
	c := compile(opts)
	res := make([]diff.NBlock, len(blocks))
	keep := make([]bool, len(blocks))
	run := func(lo, hi int) {
		for i := lo; i < hi; i++ {
			res[i], keep[i] = c.block(blocks[i])
		}
	}

	// Blocks are independent, so large Captures are split across CPUs; the
	// output order does not depend on scheduling.
	workers := min(runtime.GOMAXPROCS(0), (len(blocks)+parallelChunk-1)/parallelChunk)
	if workers <= 1 {
		run(0, len(blocks))
	} else {
		var wg sync.WaitGroup
		per := (len(blocks) + workers - 1) / workers
		for lo := 0; lo < len(blocks); lo += per {
			hi := min(lo+per, len(blocks))
			wg.Go(func() { run(lo, hi) })
		}
		wg.Wait()
	}

	out := res[:0]
	for i := range res {
		if keep[i] {
			out = append(out, res[i])
		}
	}
	return out
}

// parallelChunk is the smallest number of blocks worth a goroutine.
const parallelChunk = 500

// block normalizes one block; ok is false when its canonical text is empty.
func (c *compiled) block(b capture.Block) (diff.NBlock, bool) {
	canon := Canonicalize(b.Text)
	if canon == "" {
		return diff.NBlock{}, false
	}
	nb := diff.NBlock{
		ID:   b.ID,
		Path: b.Path,
		Tag:  b.Tag,
		Rect: b.Rect,
	}
	if canon == b.Text {
		nb.Display = canon
	} else {
		nb.Display = collapseSpace(b.Text)
	}
	nb.Tokens, nb.Masked = c.mask(canon)
	if nb.Masked == nil {
		nb.Compare = diff.FoldPunctuation(canon)
	} else {
		var cmp strings.Builder
		cmp.Grow(len(canon))
		for _, t := range nb.Tokens {
			cmp.WriteString(t.Compare)
		}
		nb.Compare = cmp.String()
	}
	nb.Ignored = c.ignore != nil && c.ignore(b.Path)
	return nb, true
}

// Canonicalize applies NFKC, turns every Unicode space into ' ', removes
// zero-width characters and soft hyphens, collapses whitespace runs and trims
// the result. Quote and dash folding is left to the Compare text.
func Canonicalize(s string) string {
	if isPlainASCII(s) {
		return s
	}
	s = norm.NFKC.String(s)
	var b strings.Builder
	b.Grow(len(s))
	pending, started := false, false
	for _, r := range s {
		switch {
		case isInvisible(r):
			continue
		case unicode.IsSpace(r):
			pending = true
			continue
		}
		if pending && started {
			b.WriteByte(' ')
		}
		pending, started = false, true
		b.WriteRune(r)
	}
	return b.String()
}

// isPlainASCII reports whether s is already canonical: printable ASCII
// (which NFKC leaves alone) with single inner spaces and no edge spaces.
func isPlainASCII(s string) bool {
	if s == "" || s[0] == ' ' || s[len(s)-1] == ' ' {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' {
			if s[i-1] == ' ' {
				return false
			}
			continue
		}
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func isInvisible(r rune) bool {
	switch r {
	case '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u180e':
		return true
	}
	return false
}

func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

// compiled is Options with the pattern list built once per Normalize call.
type compiled struct {
	patterns []*pattern
	ignore   func(path string) bool
}

func compile(opts Options) *compiled {
	c := &compiled{ignore: opts.Ignore}
	c.patterns = append(c.patterns, builtinPatterns...)
	c.patterns = append(c.patterns, todayPatterns(opts.CaptureDate)...)
	return c
}
