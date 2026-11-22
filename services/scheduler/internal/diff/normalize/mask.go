package normalize

import (
	"slices"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
)

// span is a byte range [start, end) of the canonical text.
type span struct {
	start, end int
	class      string
}

func (s span) overlaps(o span) bool { return s.start < o.end && o.start < s.end }

// Placeholder returns the Compare text of a masked token of the class.
func Placeholder(class string) string { return "⟨" + class + "⟩" }

// mask tokenizes canonical text, replacing every accepted volatile span with
// a single mask token. It returns the tokens and the sorted, unique classes
// masked.
func (c *compiled) mask(canon string) ([]diff.Token, []string) {
	spans := c.candidates(canon)
	if len(spans) == 0 {
		return diff.Tokenize(canon), nil
	}

	// Tokenize the unmasked stretches first so the result is allocated once.
	parts := make([][]diff.Token, 0, 2*len(spans)+1)
	n, pos := 0, 0
	for _, s := range spans {
		if s.start > pos {
			p := diff.Tokenize(canon[pos:s.start])
			parts = append(parts, p)
			n += len(p)
		}
		parts = append(parts, nil)
		n++
		pos = s.end
	}
	var tail []diff.Token
	if pos < len(canon) {
		tail = diff.Tokenize(canon[pos:])
		n += len(tail)
	}

	tokens := make([]diff.Token, 0, n)
	var classes []string
	si := 0
	for _, p := range parts {
		if p != nil {
			tokens = append(tokens, p...)
			continue
		}
		s := spans[si]
		si++
		tokens = append(tokens, diff.Token{
			Display: canon[s.start:s.end],
			Compare: Placeholder(s.class),
			Mask:    s.class,
			Kind:    diff.TokenMask,
		})
		if !slices.Contains(classes, s.class) {
			classes = append(classes, s.class)
		}
	}
	tokens = append(tokens, tail...)
	slices.Sort(classes)
	return tokens, classes
}

// candidates finds every mask match, drops those touching protected text,
// and resolves overlaps: earliest start, then longest, then class priority.
func (c *compiled) candidates(canon string) []span {
	f := blockFeatures(canon)
	var spans []span
	for _, p := range c.patterns {
		if !p.applies(&f) {
			continue
		}
		for _, m := range p.re.FindAllStringSubmatchIndex(canon, -1) {
			s, e := m[2*p.group], m[2*p.group+1]
			if s < 0 || s == e {
				continue
			}
			if p.check != nil && !p.check(canon[s:e]) {
				continue
			}
			spans = append(spans, span{start: s, end: e, class: p.class})
		}
	}
	if len(spans) == 0 {
		return nil
	}

	protected := protectedSpans(canon, &f)
	if len(protected) > 0 {
		spans = slices.DeleteFunc(spans, func(s span) bool {
			return slices.ContainsFunc(protected, s.overlaps)
		})
	}

	slices.SortFunc(spans, func(a, b span) int {
		if a.start != b.start {
			return a.start - b.start
		}
		if a.end != b.end {
			return b.end - a.end
		}
		return classPriority[a.class] - classPriority[b.class]
	})
	out := spans[:0]
	end := 0
	for _, s := range spans {
		if s.start < end {
			continue
		}
		out = append(out, s)
		end = s.end
	}
	return out
}

// protectedSpans finds the text that is never masked: prices and stock
// counts.
func protectedSpans(canon string, f *features) []span {
	var out []span
	for _, p := range protectPatterns {
		if !p.applies(f) {
			continue
		}
		for _, m := range p.re.FindAllStringIndex(canon, -1) {
			out = append(out, span{start: m[0], end: m[1]})
		}
	}
	return out
}
