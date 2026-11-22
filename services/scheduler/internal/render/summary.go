package render

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/decide"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
)

const (
	subjectMaxRunes  = 150
	newBlockMaxRunes = 60
)

// Subject is the one-line subject: "{monitor}: {summary}", newlines folded
// and capped at 150 characters.
func Subject(r changerecord.Record) string {
	return truncate(oneLine(monitorName(r)+": "+Summary(r)), subjectMaxRunes)
}

// Summary is the sentence every Channel leads with: the record's summary
// (the agent's one-sentence answer) when it has one, else TemplateSummary.
func Summary(r changerecord.Record) string {
	if s := oneLine(r.Summary); s != "" {
		return s
	}
	return TemplateSummary(r)
}

// TemplateSummary builds a summary from the evidence alone, for records the
// agent did not answer for (it was unavailable, or was never asked):
//
//   - text: "New: {block}" for a single added block, else "{n} words added,
//     {m} removed"
//   - visual only: "{Section} looks different", or "Looks different ({pct} %
//     of the page)" without a Watch Plan
func TemplateSummary(r changerecord.Record) string {
	if s, ok := textSummary(r); ok {
		return s
	}
	if r.Visual != nil && len(r.Visual.Regions) > 0 {
		return visualSummary(r)
	}
	return "Page changed"
}

func monitorName(r changerecord.Record) string {
	if s := oneLine(r.Monitor.Name); s != "" {
		return s
	}
	if r.Monitor.URL != "" {
		return r.Monitor.URL
	}
	return "Monitor"
}

func textSummary(r changerecord.Record) (string, bool) {
	t := r.NotifyText()
	if t == nil {
		return "", false
	}
	var counted []diff.TextOp
	for _, op := range t.Ops {
		if op.Counted() {
			counted = append(counted, op)
		}
	}
	if len(counted) == 0 {
		return "", false
	}
	if len(counted) == 1 && counted[0].Op == diff.OpAdd {
		if s := oneLine(counted[0].Text); s != "" {
			return "New: " + truncate(s, newBlockMaxRunes), true
		}
	}

	mag := r.Magnitude
	if r.Cumulative != nil && r.Cumulative.Text != nil {
		mag = r.Cumulative.Magnitude
	}
	added, removed := mag.WordsAdded, mag.WordsRemoved
	switch {
	case added > 0 && removed > 0:
		return fmt.Sprintf("%s added, %d removed", plural(added, "word", "words"), removed), true
	case added > 0:
		return plural(added, "word", "words") + " added", true
	case removed > 0:
		return plural(removed, "word", "words") + " removed", true
	}
	moves := 0
	for _, op := range counted {
		if op.Op == diff.OpMove {
			moves++
		}
	}
	if moves == len(counted) {
		return plural(moves, "item", "items") + " moved", true
	}
	return plural(len(counted), "block", "blocks") + " changed", true
}

// visualSummary names the Sections that look different. Under a Watch Plan
// the changed share of the page says little (only Sections are compared), so
// it is given only when the whole page was.
func visualSummary(r changerecord.Record) string {
	var names []string
	outside := false
	for _, reg := range r.Visual.Regions {
		name := oneLine(r.SectionName(reg.Section))
		switch {
		case name == "":
			outside = true
		case !containsString(names, name):
			names = append(names, name)
		}
	}
	switch {
	case len(names) == 0 && len(r.Sections) == 0:
		return fmt.Sprintf("Looks different (%s %% of the page)", formatPct(r.Visual.AreaRatio))
	case len(names) == 0:
		return "The page looks different"
	case len(names) == 1 && !outside:
		return truncate(names[0], newBlockMaxRunes) + " looks different"
	case len(names) == 2 && !outside:
		return truncate(names[0]+" and "+names[1], 2*newBlockMaxRunes) + " look different"
	}
	return plural(len(r.Visual.Regions), "part of the page looks", "parts of the page look") + " different"
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// NoteLine joins the lines of why[] an owner should read next to a Change
// they are being told about: that it was seen on two checks, or that the
// agent could not review it. What the agent found is the summary and the
// items, so its own line is left out.
func NoteLine(r changerecord.Record) string {
	var parts []string
	for _, w := range r.Why {
		if w.Kind != decide.WhyPersistence && w.Kind != decide.WhyNote {
			continue
		}
		if detail := strings.TrimSuffix(oneLine(w.Detail), "."); detail != "" {
			parts = append(parts, detail)
		}
	}
	return strings.Join(parts, " · ")
}

// FormatNumber prints a number without trailing zeros: 49 → "49",
// 49.50 → "49.5".
func FormatNumber(v float64) string {
	s := strconv.FormatFloat(v, 'f', 6, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "-0" {
		s = "0"
	}
	return s
}

// formatPct prints a 0..1 ratio as a percentage number: "4", "0.4", "< 0.1".
func formatPct(ratio float64) string {
	v := ratio * 100
	switch {
	case v <= 0:
		return "0"
	case v < 0.1:
		return "< 0.1"
	case v < 10:
		return FormatNumber(float64(int(v*10+0.5)) / 10)
	default:
		return strconv.Itoa(int(v + 0.5))
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// oneLine folds every whitespace run (newlines included) into one space.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// truncate caps s at max runes, ending with "…" when cut.
func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	runes := []rune(s)
	return strings.TrimRight(string(runes[:max-1]), " ") + "…"
}
