package visual

import (
	"image"

	"github.com/sammaji/watchthatsite/packages/image-diff/imagediff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// Section is one part of the page as the Watch Plan divides it, located on
// both screenshots.
type Section struct {
	ID string
	// A and B are the Section's rectangle on the before and the after
	// screenshot, each in its own coordinates. An empty rectangle means the
	// Section is not on that side.
	A, B geom.Rect
	// Compare is true when the Section is watched for how it looks. Other
	// Sections are only kept out of the comparisons around them.
	Compare bool
}

// SectionOptions carries everything CompareSections needs besides the two
// screenshots.
type SectionOptions struct {
	// Options holds each Capture's masks and blocks, in page coordinates.
	Options
	Sections []Section
	// Rest also compares the page outside every Section.
	Rest bool
}

// CompareSections compares the before screenshot a with the after screenshot
// b Section by Section.
//
// Each Section with Compare set is cropped out of both screenshots, at the
// place it occupies on each, and the two crops are compared like two small
// pages. Content inserted above a Section moves it on the page but not
// inside its crop, so it cannot turn the Section into a changed region, and
// a tall page costs only the Sections that matter. A Section that exists on
// one side only is reported as one region covering it.
//
// A Section nested inside the one being compared is masked out of the crop:
// it is compared (or ignored) on its own.
//
// With Rest, the page is also compared as a whole with every Section's
// rectangle masked out on each side.
//
// Regions come back in page coordinates, tagged with their Section's id (""
// for the rest pass), Sections first in the order given.
func CompareSections(a, b image.Image, opts SectionOptions) *diff.VisualEvidence {
	na, nb := imagediff.ToNRGBA(a), imagediff.ToNRGBA(b)
	boundsA := image.Rect(0, 0, na.Bounds().Dx(), na.Bounds().Dy())
	boundsB := image.Rect(0, 0, nb.Bounds().Dx(), nb.Bounds().Dy())
	ev := &diff.VisualEvidence{
		Regions:    []diff.Region{},
		SizeBefore: [2]int{boundsA.Dx(), boundsA.Dy()},
		SizeAfter:  [2]int{boundsB.Dx(), boundsB.Dy()},
	}

	// Clamp every Section to the screenshots once.
	sections := make([]Section, len(opts.Sections))
	for i, s := range opts.Sections {
		s.A = geom.FromImage(s.A.Image().Intersect(boundsA))
		s.B = geom.FromImage(s.B.Image().Intersect(boundsB))
		sections[i] = s
	}

	for i, s := range sections {
		if !s.Compare {
			continue
		}
		switch {
		case s.A.Empty() && s.B.Empty():
			continue
		case s.A.Empty():
			r := oneSided(diff.RegionInsertedBand, s.B, false, opts.Options)
			r.Section = s.ID
			ev.Regions = append(ev.Regions, r)
			ev.ChangedPixels += r.Pixels
			ev.UnmaskedPixels += r.Pixels
			continue
		case s.B.Empty():
			r := oneSided(diff.RegionRemovedBand, s.A, true, opts.Options)
			r.Section = s.ID
			ev.Regions = append(ev.Regions, r)
			ev.ChangedPixels += r.Pixels
			ev.UnmaskedPixels += r.Pixels
			continue
		}

		masksA, masksB := opts.MasksA, opts.MasksB
		for j, inner := range sections {
			if j == i {
				continue
			}
			if inner.A.Area() < s.A.Area() {
				masksA = append(masksA[:len(masksA):len(masksA)], inner.A)
			}
			if inner.B.Area() < s.B.Area() {
				masksB = append(masksB[:len(masksB):len(masksB)], inner.B)
			}
		}
		sub := Compare(crop(na, s.A), crop(nb, s.B), Options{
			MasksA: translate(masksA, s.A),
			MasksB: translate(masksB, s.B),
		})
		for _, r := range sub.Regions {
			ev.Regions = append(ev.Regions, toPage(r, s, opts.Options))
		}
		ev.ChangedPixels += sub.ChangedPixels
		ev.UnmaskedPixels += sub.UnmaskedPixels
	}

	if opts.Rest {
		rest := opts.Options
		for _, s := range sections {
			rest.MasksA = append(rest.MasksA[:len(rest.MasksA):len(rest.MasksA)], s.A)
			rest.MasksB = append(rest.MasksB[:len(rest.MasksB):len(rest.MasksB)], s.B)
		}
		sub := Compare(na, nb, rest)
		var rectsA, rectsB []geom.Rect
		for _, s := range sections {
			rectsA, rectsB = append(rectsA, s.A), append(rectsB, s.B)
		}
		for _, r := range sub.Regions {
			// A Section that grew, shrank, appeared or went away leaves a
			// band of its own masked rows in the rest pass. That band is
			// the Section's business, not the rest's.
			inside := rectsB
			if r.BeforeOnly() {
				inside = rectsA
			}
			if covered(r.Box, inside) {
				sub.ChangedPixels -= r.Pixels
				continue
			}
			ev.Regions = append(ev.Regions, r)
		}
		// Only the rest pass sees the whole page, so only its shift is in
		// page coordinates.
		ev.Shift = sub.Shift
		ev.ChangedPixels += sub.ChangedPixels
		ev.UnmaskedPixels += sub.UnmaskedPixels
	}

	if ev.UnmaskedPixels > 0 {
		ev.AreaRatio = min(1, float64(ev.ChangedPixels)/float64(ev.UnmaskedPixels))
	}
	return ev
}

// restCoverage is the share of a rest-pass region that must lie inside
// Sections for the region to be left to them.
const restCoverage = 0.9

// covered reports whether box lies almost entirely inside rects.
func covered(box geom.Rect, rects []geom.Rect) bool {
	if box.Empty() {
		return false
	}
	return float64(unionArea(rects, box.Image())) >= restCoverage*float64(box.Area())
}

// crop copies rect out of img into an image of its own, origin at (0, 0).
func crop(img *image.NRGBA, rect geom.Rect) *image.NRGBA {
	return cloneNRGBA(img.SubImage(rect.Image().Add(img.Rect.Min)))
}

// translate moves page rectangles into the coordinates of a crop at origin,
// dropping those that do not touch it.
func translate(rects []geom.Rect, origin geom.Rect) []geom.Rect {
	var out []geom.Rect
	for _, r := range rects {
		if !r.Empty() && r.Intersects(origin) {
			out = append(out, geom.Rect{r.X() - origin.X(), r.Y() - origin.Y(), r.W(), r.H()})
		}
	}
	return out
}

// toPage moves a region found between a Section's two crops back into page
// coordinates: the after side by the Section's place on the after
// screenshot, the before side by its place on the before screenshot.
func toPage(r diff.Region, s Section, opts Options) diff.Region {
	shift := func(box geom.Rect, by geom.Rect) geom.Rect {
		return geom.Rect{box.X() + by.X(), box.Y() + by.Y(), box.W(), box.H()}
	}
	r.Section = s.ID
	if r.FromBox != nil {
		from := shift(*r.FromBox, s.A)
		r.FromBox = &from
	}
	if r.BeforeOnly() {
		r.Box = *r.FromBox
		r.Blocks = linkBlocks(r.Box, opts.BlocksA)
		return r
	}
	r.Box = shift(r.Box, s.B)
	r.Blocks = linkBlocks(r.Box, opts.BlocksB)
	return r
}
