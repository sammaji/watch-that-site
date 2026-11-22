package pipeline

import (
	"context"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff/normalize"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff/text"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff/visual"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
)

// normalizeSide fills a side's normalized blocks and fingerprints under the
// Monitor's Watch Plan. Blocks the plan does not watch as text (an ignored
// Section, or one watched only for how it looks) are kept and aligned, but
// they never count and are left out of the fingerprint: two Captures that
// differ only there are the same page as far as the owner's words go.
func (p *Pipeline) normalizeSide(cfg monitor.Config, s *side) {
	opts := normalize.Options{CaptureDate: s.row.CreatedAt}
	if plan := cfg.WatchPlan; plan != nil {
		opts.Ignore = func(path string) bool { return !plan.HowFor(path).Text() }
	}
	s.blocks = normalize.Normalize(s.stored.Blocks, opts)

	compare := make([]string, 0, len(s.blocks))
	for _, b := range s.blocks {
		if !b.Ignored {
			compare = append(compare, b.Compare)
		}
	}
	s.textHash, s.simHash = capture.TextFingerprint(compare)
}

// compare runs both Comparators on two Captures and says which Section each
// difference is in.
func (p *Pipeline) compare(ctx context.Context, cfg monitor.Config, a, b *side) diff.Evidence {
	return diff.Evidence{
		Text:   tagSections(cfg.WatchPlan, text.Compare(a.blocks, b.blocks)),
		Visual: p.compareVisual(ctx, cfg, a, b),
	}
}

// tagSections records on every text op the Section its block lies in.
func tagSections(plan *monitor.WatchPlan, ev *diff.TextEvidence) *diff.TextEvidence {
	if plan == nil || ev == nil {
		return ev
	}
	for i := range ev.Ops {
		ev.Ops[i].Section = plan.SectionID(ev.Ops[i].Path)
	}
	return ev
}

// compareVisual runs the visual Comparator, or returns nil when either
// screenshot is missing. Without a Watch Plan the whole page is compared.
// With one, each Section watched for how it looks is compared crop against
// crop, and the rest of the page only if the plan says so.
func (p *Pipeline) compareVisual(ctx context.Context, cfg monitor.Config, a, b *side) *diff.VisualEvidence {
	before, errA := p.image(ctx, a)
	after, errB := p.image(ctx, b)
	if errA != nil || errB != nil {
		p.log.Warn("visual comparison skipped", "monitor_id", cfg.ID, "before_err", errA, "after_err", errB)
		return nil
	}
	opts := visual.Options{
		MasksA:  a.stored.Masks,
		MasksB:  b.stored.Masks,
		BlocksA: a.stored.Blocks,
		BlocksB: b.stored.Blocks,
	}
	plan := cfg.WatchPlan
	if plan == nil {
		return visual.Compare(before, after, opts)
	}

	rectsA, rectsB := sectionRects(plan, a.stored.Blocks), sectionRects(plan, b.stored.Blocks)
	sections := make([]visual.Section, len(plan.Sections))
	for i, s := range plan.Sections {
		sections[i] = visual.Section{ID: s.ID, A: rectsA[i], B: rectsB[i], Compare: s.How.Visual()}
	}
	return visual.CompareSections(before, after, visual.SectionOptions{
		Options:  opts,
		Sections: sections,
		Rest:     plan.RestHow().Visual(),
	})
}

// sectionRects locates every Section of the plan on one Capture: the union
// of the rectangles of the blocks that belong to it. A block belongs to the
// most specific Section around it, so a Section nested in another has its
// own rectangle. A Section with no block on this Capture has an empty one.
func sectionRects(plan *monitor.WatchPlan, blocks []capture.Block) []geom.Rect {
	rects := make([]geom.Rect, len(plan.Sections))
	index := make(map[string]int, len(plan.Sections))
	for i, s := range plan.Sections {
		index[s.ID] = i
	}
	for _, b := range blocks {
		if b.Rect.Empty() {
			continue
		}
		if s := plan.SectionFor(b.Path); s != nil {
			i := index[s.ID]
			rects[i] = rects[i].Union(b.Rect)
		}
	}
	return rects
}
