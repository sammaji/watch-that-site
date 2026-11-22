package render

import (
	"strconv"
	"strings"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/changerecord"
)

// MaxItems is the number of items a notification shows before "+N more".
const MaxItems = 5

const (
	itemTitleMaxRunes = 120
	itemValueMaxRunes = 280
)

// itemLine is one of the agent's items as every renderer sees it.
type itemLine struct {
	Title string
	// Section is the name of the Watch Plan Section it lies in, or "".
	Section string
	// Before and After are what it was and what it is now. Before is "" for
	// something new, After for something removed.
	Before, After string
}

// itemSet is the (possibly truncated) list of items to render.
type itemSet struct {
	Lines []itemLine
	// Total counts every item, shown or not.
	Total int
}

// More is the number of items not shown.
func (s itemSet) More() int { return s.Total - len(s.Lines) }

// items collects the first MaxItems items of the record.
func items(r changerecord.Record) itemSet {
	set := itemSet{Total: len(r.Items)}
	for _, it := range r.Items {
		if len(set.Lines) == MaxItems {
			break
		}
		title := oneLine(it.Title)
		if title == "" {
			title = "Changed"
		}
		// A title that already names its Section does not need it repeated.
		section := oneLine(r.ItemSection(it))
		if strings.Contains(strings.ToLower(title), strings.ToLower(section)) {
			section = ""
		}
		set.Lines = append(set.Lines, itemLine{
			Title:   truncate(title, itemTitleMaxRunes),
			Section: truncate(section, itemTitleMaxRunes),
			Before:  truncate(oneLine(it.Before), itemValueMaxRunes),
			After:   truncate(oneLine(it.After), itemValueMaxRunes),
		})
	}
	return set
}

// head is the item's title, followed by its Section when it has one.
func (l itemLine) head() string {
	if l.Section == "" {
		return l.Title
	}
	return l.Title + " · " + l.Section
}

// text is the plain before → after line, or "" when the item has neither.
func (l itemLine) text() string {
	switch {
	case l.Before != "" && l.After != "":
		return l.Before + " → " + l.After
	case l.After != "":
		return "New: " + l.After
	case l.Before != "":
		return "Removed: " + l.Before
	}
	return ""
}

func moreItemsText(n int) string {
	if n == 1 {
		return "+1 more"
	}
	return "+" + strconv.Itoa(n) + " more"
}
