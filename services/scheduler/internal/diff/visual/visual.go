// Package visual is the visual Comparator: it compares two screenshots after
// masking, aligns their rows so content that merely moved is not reported as
// changed, and reports the changed areas as regions linked to the Capture
// blocks they overlap. With a Watch Plan it compares each visual Section crop
// against crop (CompareSections), so movement elsewhere on the page cannot
// disturb a Section.
package visual

import (
	"bytes"
	"image"
	"image/color"
	"slices"

	"github.com/sammaji/watchthatsite/packages/image-diff/imagediff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

const (
	// shiftMinShare is the share of the after image's rows a single offset
	// must explain before it is recorded as a Shift.
	shiftMinShare = 0.30
	// minRegionPixels drops regions with fewer changed pixels than this.
	minRegionPixels = 24
	// minRegionSide drops boxes (and bands) narrower or shorter than this.
	minRegionSide = 4
)

// maskColor is the neutral grey masked areas are painted with.
var maskColor = color.NRGBA{R: 0x80, G: 0x80, B: 0x80, A: 0xff}

// Options carries everything besides the two screenshots.
type Options struct {
	// MasksA and MasksB are the regions each Capture saw animating
	// (Capture.Masks), in that Capture's own coordinates.
	MasksA, MasksB []geom.Rect
	// BlocksA and BlocksB are the Capture blocks, used to link regions to
	// block ids.
	BlocksA, BlocksB []capture.Block
}

// Compare compares the before screenshot a with the after screenshot b.
//
// Masking: each screenshot gets its own Capture's masks painted neutral grey
// before rows are hashed. When a stretch of rows
// that did not align is pixel-compared, the masks of both Captures are painted
// on both sides of that stretch, translated to it, so a masked element that
// resized or exists on one side only is still hidden. Painting the other
// side's masks at their raw coordinates before alignment would be wrong as
// soon as content shifts: the mask would then hide unrelated content on the
// other side and surface it as a change. Inputs are never mutated.
//
// Alignment: see alignRows. Aligned rows are equal by construction; the
// stretches between them are compared with imagediff at the default
// threshold (0.1) with anti-aliasing excluded. A stretch taller on one side
// is compared over the common height and the rest is an inserted or removed
// band.
func Compare(a, b image.Image, opts Options) *diff.VisualEvidence {
	wa, ha := a.Bounds().Dx(), a.Bounds().Dy()
	wb, hb := b.Bounds().Dx(), b.Bounds().Dy()
	ev := &diff.VisualEvidence{
		Regions:    []diff.Region{},
		SizeBefore: [2]int{wa, ha},
		SizeAfter:  [2]int{wb, hb},
	}
	ev.UnmaskedPixels = wb*hb - unionArea(opts.MasksB, image.Rect(0, 0, wb, hb))

	na := masked(a, opts.MasksA)
	nb := masked(b, opts.MasksB)

	if wa == wb && ha == hb && bytes.Equal(na.Pix, nb.Pix) {
		return ev
	}

	c := &comparer{a: na, b: nb, w: min(wa, wb), opts: opts}
	runs := alignRows(hashRows(na, c.w), hashRows(nb, c.w))
	if fromY, dy, ok := dominantShift(runs, int(shiftMinShare*float64(hb)+0.5)); ok {
		ev.Shift = &diff.Shift{FromY: fromY, DY: dy}
	}
	for _, g := range gaps(runs, ha, hb) {
		c.compareGap(g)
	}
	switch {
	case wb > wa:
		c.band(diff.RegionExtraWidth, image.Rect(wa, 0, wb, hb), false)
	case wa > wb:
		c.band(diff.RegionExtraWidth, image.Rect(wb, 0, wa, ha), true)
	}

	ev.Regions = c.regions
	for _, r := range ev.Regions {
		ev.ChangedPixels += r.Pixels
	}
	if ev.UnmaskedPixels > 0 {
		ev.AreaRatio = min(1, float64(ev.ChangedPixels)/float64(ev.UnmaskedPixels))
	}
	return ev
}

// comparer accumulates regions while the gaps are compared.
type comparer struct {
	a, b    *image.NRGBA
	w       int
	opts    Options
	regions []diff.Region
}

// compareGap compares one unaligned stretch.
func (c *comparer) compareGap(g gap) {
	common := min(g.a1-g.a0, g.b1-g.b0)
	if common > 0 {
		c.pixelDiff(g.a0, g.b0, common)
	}
	switch {
	case g.b1-g.b0 > common:
		c.band(diff.RegionInsertedBand, image.Rect(0, g.b0+common, c.b.Rect.Dx(), g.b1), false)
	case g.a1-g.a0 > common:
		c.band(diff.RegionRemovedBand, image.Rect(0, g.a0+common, c.a.Rect.Dx(), g.a1), true)
	}
}

// band records a whole area that exists on one side only: the before side
// when before is set, else the after side. It counts at full size.
func (c *comparer) band(kind string, r image.Rectangle, before bool) {
	if r.Dx() < minRegionSide || r.Dy() < minRegionSide {
		return
	}
	c.regions = append(c.regions, oneSided(kind, geom.FromImage(r), before, c.opts))
}

// oneSided builds the region for an area that exists on one screenshot only.
func oneSided(kind string, box geom.Rect, before bool, opts Options) diff.Region {
	r := diff.Region{Box: box, Kind: kind, Pixels: box.Area()}
	if before {
		r.FromBox = &box
		r.Blocks = linkBlocks(box, opts.BlocksA)
	} else {
		r.Blocks = linkBlocks(box, opts.BlocksB)
	}
	return r
}

// regionOptions are imagediff's defaults with the minimum region size.
func regionOptions() *imagediff.RegionOptions {
	ro := imagediff.DefaultRegionOptions()
	ro.MinDiffPixels = minRegionPixels
	return ro
}

// pixelOptions are imagediff's defaults (threshold 0.1, anti-aliasing
// excluded) on one goroutine: the result consumer already runs Captures
// concurrently, so the consumer's worker count stays the single CPU knob.
func pixelOptions() *imagediff.Options {
	pm := imagediff.DefaultOptions()
	pm.Workers = 1
	return pm
}

// pixelDiff compares before rows [a0, a0+h) with after rows [b0, b0+h) over
// the overlapping width and records the changed regions in after
// coordinates, each with the box it was compared against on the before side.
func (c *comparer) pixelDiff(a0, b0, h int) {
	subA := rowView(c.a, a0, h, c.w)
	subB := rowView(c.b, b0, h, c.w)

	// Paint both Captures' masks on both sides, translated into the
	// stretch's coordinates.
	var masks []image.Rectangle
	for _, m := range c.opts.MasksA {
		masks = append(masks, m.Image().Sub(image.Pt(0, a0)))
	}
	for _, m := range c.opts.MasksB {
		masks = append(masks, m.Image().Sub(image.Pt(0, b0)))
	}
	bounds := image.Rect(0, 0, c.w, h)
	masks = slices.DeleteFunc(masks, func(r image.Rectangle) bool { return !r.Overlaps(bounds) })
	if len(masks) > 0 {
		subA, subB = cloneNRGBA(subA), cloneNRGBA(subB)
		for _, m := range masks {
			fillRect(subA, m)
			fillRect(subB, m)
		}
	}

	res, err := imagediff.Diff(subA, subB, &imagediff.DiffOptions{
		Pixelmatch: pixelOptions(),
		Regions:    regionOptions(),
	})
	if err != nil || res.DiffPixels == 0 {
		// Bounds always match here; an error is unreachable.
		return
	}
	for _, box := range res.Boxes {
		if box.Dx() < minRegionSide || box.Dy() < minRegionSide {
			continue
		}
		n := countChanged(res.Mask, res.Width, box)
		if n == 0 {
			continue
		}
		r := geom.FromImage(box.Add(image.Pt(0, b0)))
		from := geom.FromImage(box.Add(image.Pt(0, a0)))
		c.regions = append(c.regions, diff.Region{
			Box:     r,
			Kind:    diff.RegionChanged,
			Pixels:  n,
			Blocks:  linkBlocks(r, c.opts.BlocksB),
			FromBox: &from,
		})
	}
}

// countChanged counts the counted diff pixels (mask value 1) inside box.
func countChanged(mask []uint8, width int, box image.Rectangle) int {
	n := 0
	for y := box.Min.Y; y < box.Max.Y; y++ {
		for _, v := range mask[y*width+box.Min.X : y*width+box.Max.X] {
			if v == 1 {
				n++
			}
		}
	}
	return n
}

// linkBlocks returns the ids of the blocks whose rect intersects box, in
// block order.
func linkBlocks(box geom.Rect, blocks []capture.Block) []string {
	var ids []string
	for _, bl := range blocks {
		if !bl.Rect.Empty() && bl.Rect.Intersects(box) {
			ids = append(ids, bl.ID)
		}
	}
	return ids
}

// rowView returns rows [y0, y0+h) and columns [0, w) of img with its origin
// at (0, 0). When the rows span the image's full width it aliases img's
// pixels (no copy), which is also the packed layout imagediff reads without
// copying.
func rowView(img *image.NRGBA, y0, h, w int) *image.NRGBA {
	off := img.PixOffset(0, y0)
	if w == img.Rect.Dx() {
		return &image.NRGBA{
			Pix:    img.Pix[off : off+h*img.Stride : off+h*img.Stride],
			Stride: img.Stride,
			Rect:   image.Rect(0, 0, w, h),
		}
	}
	return &image.NRGBA{
		Pix:    img.Pix[off:],
		Stride: img.Stride,
		Rect:   image.Rect(0, 0, w, h),
	}
}

// cloneNRGBA copies any image into a fresh, packed NRGBA with its origin at
// (0, 0).
func cloneNRGBA(img image.Image) *image.NRGBA {
	b := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	if src, ok := img.(*image.NRGBA); ok {
		n := b.Dx() * 4
		for y := 0; y < b.Dy(); y++ {
			so := src.PixOffset(b.Min.X, b.Min.Y+y)
			copy(dst.Pix[y*dst.Stride:y*dst.Stride+n], src.Pix[so:so+n])
		}
		return dst
	}
	packed := imagediff.ToNRGBA(img)
	copy(dst.Pix, packed.Pix)
	return dst
}

// masked returns img as a packed NRGBA with rects painted in the mask
// colour. It copies img only when a rect touches it or it is not already a
// packed NRGBA; the result must be treated as read-only either way.
func masked(img image.Image, rects []geom.Rect) *image.NRGBA {
	bounds := image.Rect(0, 0, img.Bounds().Dx(), img.Bounds().Dy())
	touches := slices.ContainsFunc(rects, func(r geom.Rect) bool { return r.Image().Overlaps(bounds) })
	if !touches {
		return imagediff.ToNRGBA(img)
	}
	out := cloneNRGBA(img)
	for _, r := range rects {
		fillRect(out, r.Image())
	}
	return out
}

// fillRect fills r (clipped to img) with the mask colour.
func fillRect(img *image.NRGBA, r image.Rectangle) {
	r = r.Intersect(img.Rect)
	if r.Empty() {
		return
	}
	for y := r.Min.Y; y < r.Max.Y; y++ {
		off := img.PixOffset(r.Min.X, y)
		row := img.Pix[off : off+r.Dx()*4]
		for x := 0; x < len(row); x += 4 {
			row[x], row[x+1], row[x+2], row[x+3] = maskColor.R, maskColor.G, maskColor.B, maskColor.A
		}
	}
}

// unionArea is the number of pixels inside bounds covered by at least one
// rect.
func unionArea(rects []geom.Rect, bounds image.Rectangle) int {
	var rs []image.Rectangle
	var ys []int
	for _, r := range rects {
		ir := r.Image().Intersect(bounds)
		if ir.Empty() {
			continue
		}
		rs = append(rs, ir)
		ys = append(ys, ir.Min.Y, ir.Max.Y)
	}
	slices.Sort(ys)
	ys = slices.Compact(ys)
	total := 0
	for i := 0; i+1 < len(ys); i++ {
		y0, y1 := ys[i], ys[i+1]
		var spans [][2]int
		for _, r := range rs {
			if r.Min.Y <= y0 && r.Max.Y >= y1 {
				spans = append(spans, [2]int{r.Min.X, r.Max.X})
			}
		}
		slices.SortFunc(spans, func(p, q [2]int) int { return p[0] - q[0] })
		covered, end := 0, -1<<31
		for _, s := range spans {
			if s[0] > end {
				covered += s[1] - s[0]
				end = s[1]
			} else if s[1] > end {
				covered += s[1] - end
				end = s[1]
			}
		}
		total += covered * (y1 - y0)
	}
	return total
}
