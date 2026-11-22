package render

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
)

// MaxOps is the number of diff lines a notification without items shows
// before "+N more".
const MaxOps = 5

const (
	contextMaxRunes = 120
	changeMaxRunes  = 280
	keptMaxRunes    = 40
)

type segKind byte

const (
	segSame segKind = '='
	segAdd  segKind = '+'
	segDel  segKind = '-'
)

type segment struct {
	Kind segKind
	Text string
}

// lineKind names one rendered change.
type lineKind string

const (
	lineAdd    lineKind = "add"
	lineRemove lineKind = "remove"
	lineModify lineKind = "modify"
	lineMove   lineKind = "move"
)

// changeLine is one text op as every renderer sees it: the op's segments
// plus one block of context on each side.
type changeLine struct {
	Kind lineKind
	// Before is the last block of context before the change; After the first
	// block after it. Either may be "".
	Before, After string
	// Segs is the inline diff. add/remove/move ops have one segment.
	Segs []segment
	// Whole marks a modify rendered as a whole-block replacement.
	Whole bool
	// Adjacent marks a change that directly follows the previous one, so
	// their shared context is shown once.
	Adjacent bool
}

// changeSet is the (possibly truncated) list of changes to render.
type changeSet struct {
	Lines []changeLine
	// Total counts every counted change, shown or not.
	Total int
}

// More is the number of changes not shown.
func (c changeSet) More() int { return c.Total - len(c.Lines) }

// changes collects the counted text ops (NotifyText: the cumulative evidence
// when present), keeping the first MaxOps. It is what a notification shows
// when the record has no items: the agent was not available, so the diff
// speaks for itself.
func changes(r changerecord.Record) changeSet {
	var cs changeSet
	if t := r.NotifyText(); t != nil {
		for _, op := range t.Ops {
			if !op.Counted() {
				continue
			}
			cs.Total++
			if len(cs.Lines) < MaxOps {
				cs.Lines = append(cs.Lines, textLine(op))
			}
		}
	}
	joinAdjacent(cs.Lines)
	return cs
}

// joinAdjacent drops context that repeats a neighbouring change: when a
// change's context before is the previous change (or its context after),
// the two are adjacent and render as one run.
func joinAdjacent(lines []changeLine) {
	for i := 1; i < len(lines); i++ {
		prev, cur := &lines[i-1], &lines[i]
		_, prevAfter := prev.sides()
		curBefore, curAfter := cur.sides()
		if cur.Before != "" && (cur.Before == prevAfter || cur.Before == prev.After) {
			cur.Before = ""
			cur.Adjacent = true
		}
		if prev.After != "" && (prev.After == curAfter || prev.After == curBefore) {
			prev.After = ""
			cur.Adjacent = true
		}
	}
}

func textLine(op diff.TextOp) changeLine {
	l := changeLine{Whole: op.Whole}
	if n := len(op.ContextBefore); n > 0 {
		l.Before = truncate(oneLine(op.ContextBefore[n-1]), contextMaxRunes)
	}
	if len(op.ContextAfter) > 0 {
		l.After = truncate(oneLine(op.ContextAfter[0]), contextMaxRunes)
	}
	switch op.Op {
	case diff.OpAdd:
		l.Kind = lineAdd
		l.Segs = []segment{{segAdd, clip(op.Text)}}
	case diff.OpRemove:
		l.Kind = lineRemove
		l.Segs = []segment{{segDel, clip(op.Text)}}
	case diff.OpMove:
		l.Kind = lineMove
		l.Segs = []segment{{segSame, clip(op.Text)}}
	default:
		l.Kind = lineModify
		l.Segs = modifySegments(op.Tokens)
	}
	return l
}

// modifySegments merges adjacent word ops of one kind, folds whitespace and
// elides long unchanged runs so the change stays in view.
func modifySegments(tokens []diff.WordOp) []segment {
	var segs []segment
	for _, t := range tokens {
		k := segSame
		switch t.Op {
		case "+":
			k = segAdd
		case "-":
			k = segDel
		}
		text := strings.Join(strings.Fields(strings.ReplaceAll(t.Text, " ", " ")), " ")
		// Keep a single boundary space where the source had one.
		if t.Text != "" && isSpace(t.Text[0]) && text != "" {
			text = " " + text
		}
		if t.Text != "" && isSpace(t.Text[len(t.Text)-1]) {
			text += " "
		}
		if text == "" {
			continue
		}
		if n := len(segs); n > 0 && segs[n-1].Kind == k {
			segs[n-1].Text += text
			continue
		}
		segs = append(segs, segment{k, text})
	}
	for i := range segs {
		switch segs[i].Kind {
		case segSame:
			segs[i].Text = elide(segs[i].Text, i == 0, i == len(segs)-1)
		default:
			segs[i].Text = clip(segs[i].Text)
		}
	}
	return segs
}

func isSpace(b byte) bool { return b == ' ' || b == '\n' || b == '\t' || b == '\r' }

// elide shortens an unchanged run: the first run keeps its tail, the last its
// head, a middle one both ends.
func elide(s string, first, last bool) string {
	runes := []rune(s)
	if len(runes) <= 2*keptMaxRunes {
		return s
	}
	switch {
	case first && !last:
		return "…" + strings.TrimLeft(string(runes[len(runes)-keptMaxRunes:]), " ")
	case last && !first:
		return strings.TrimRight(string(runes[:keptMaxRunes]), " ") + "…"
	default:
		return string(runes[:keptMaxRunes]) + " … " + string(runes[len(runes)-keptMaxRunes:])
	}
}

func clip(s string) string { return truncate(oneLine(s), changeMaxRunes) }

// sides joins the before and after text of a line's segments.
func (l changeLine) sides() (before, after string) {
	var b, a strings.Builder
	for _, s := range l.Segs {
		switch s.Kind {
		case segSame:
			b.WriteString(s.Text)
			a.WriteString(s.Text)
		case segDel:
			b.WriteString(s.Text)
		case segAdd:
			a.WriteString(s.Text)
		}
	}
	return strings.TrimSpace(b.String()), strings.TrimSpace(a.String())
}

// diffLines renders a change as unified-diff lines ("  " context, "- "
// removed, "+ " added) for plain text, Slack and Discord.
func (l changeLine) diffLines() []string {
	var out []string
	if l.Before != "" {
		out = append(out, "  "+l.Before)
	}
	switch l.Kind {
	case lineAdd:
		out = append(out, "+ "+l.Segs[0].Text)
	case lineRemove:
		out = append(out, "- "+l.Segs[0].Text)
	case lineMove:
		out = append(out, "  ↪ moved: "+l.Segs[0].Text)
	default:
		before, after := l.sides()
		if before != "" {
			out = append(out, "- "+before)
		}
		if after != "" {
			out = append(out, "+ "+after)
		}
	}
	if l.After != "" {
		out = append(out, "  "+l.After)
	}
	return out
}

// diffText renders the change set as a unified diff, stopping before a line
// would push it over budget runes. It reports how many changes it rendered.
func diffText(lines []changeLine, budget int) (string, int) {
	var b strings.Builder
	used, n := 0, 0
	for i, l := range lines {
		block := strings.Join(l.diffLines(), "\n")
		switch {
		case i > 0 && l.Adjacent:
			block = "\n" + block
		case i > 0:
			block = "\n\n" + block
		}
		size := utf8.RuneCountInString(block)
		if used+size > budget {
			break
		}
		b.WriteString(block)
		used += size
		n++
	}
	return b.String(), n
}

func moreText(n int) string {
	if n == 1 {
		return "+1 more change"
	}
	return "+" + strconv.Itoa(n) + " more changes"
}
