package changerecord

import (
	"slices"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// Guard checks the agent's items against the evidence they cite, so nothing
// the diff does not show can reach the owner. For each item it strips the op
// and region indexes that are out of range (or point at an ignored op, which
// the agent was never shown), drops the item when none is left, and fills
// RectBefore and RectAfter from what the item still cites.
//
// The agent API applies the same guard; this is the second line, and the
// one that holds when a stored answer is reused against fresh evidence.
func Guard(items []Item, ops []diff.TextOp, regions []diff.Region) []Item {
	out := make([]Item, 0, len(items))
	for _, it := range items {
		it.Ops = validIndexes(it.Ops, len(ops), func(i int) bool { return ops[i].Counted() })
		it.Regions = validIndexes(it.Regions, len(regions), nil)
		if len(it.Ops) == 0 && len(it.Regions) == 0 {
			continue
		}
		if it.Kind != ItemText && it.Kind != ItemVisual {
			it.Kind = ItemText
			if len(it.Ops) == 0 {
				it.Kind = ItemVisual
			}
		}
		it.RectBefore, it.RectAfter = itemRects(it, ops, regions)
		out = append(out, it)
	}
	return out
}

// validIndexes keeps the in-range indexes that pass ok, once each, in the
// order given. It never returns nil, so the JSON is always an array.
func validIndexes(idx []int, n int, ok func(int) bool) []int {
	out := make([]int, 0, len(idx))
	for _, i := range idx {
		if i < 0 || i >= n || slices.Contains(out, i) {
			continue
		}
		if ok != nil && !ok(i) {
			continue
		}
		out = append(out, i)
	}
	return out
}

// itemRects is the union of the rectangles of everything an item cites, on
// each screenshot. Either is nil when nothing it cites is on that side.
func itemRects(it Item, ops []diff.TextOp, regions []diff.Region) (before, after *geom.Rect) {
	var b, a geom.Rect
	add := func(dst *geom.Rect, r *geom.Rect) {
		if r != nil {
			*dst = dst.Union(*r)
		}
	}
	for _, i := range it.Ops {
		add(&b, ops[i].FromRect)
		add(&a, ops[i].Rect)
	}
	for _, i := range it.Regions {
		add(&b, regions[i].RectBefore())
		add(&a, regions[i].RectAfter())
	}
	if !b.Empty() {
		before = &b
	}
	if !a.Empty() {
		after = &a
	}
	return before, after
}
