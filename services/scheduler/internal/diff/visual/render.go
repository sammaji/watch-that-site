package visual

import (
	"image"
	"image/color"
	"strconv"

	xdraw "golang.org/x/image/draw"

	"github.com/sammaji/watchthatsite/packages/image-diff/imagediff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
)

const (
	// dimOpacity is how much of an unchanged pixel survives the dimming; the
	// rest is white.
	dimOpacity = 0.4
	// digitScale is the pixel size of one cell of the 3×5 digit font.
	digitScale = 3
	// cropGutter separates the before and after panels of a Crop.
	cropGutter = 8
	// cropContext is how many rows around a region are used to find where
	// it sits on the other screenshot.
	cropContext = 200
)

var (
	boxRed     = color.NRGBA{R: 0xe0, G: 0x1b, B: 0x24, A: 0xff}
	labelWhite = color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
	panelGrey  = color.NRGBA{R: 0xe5, G: 0xe5, B: 0xe5, A: 0xff}
)

// RenderDiff returns the after screenshot with everything outside the
// regions faded to 40 % over white, each region outlined in red and numbered
// by its 1-based position in ev.Regions. Removed bands have no place on the
// after screenshot and are not drawn, but keep their number.
func RenderDiff(after image.Image, ev *diff.VisualEvidence) *image.NRGBA {
	dst := cloneNRGBA(after)
	var boxes []image.Rectangle
	var numbered []int
	if ev != nil {
		for i, r := range ev.Regions {
			if r.Kind == diff.RegionRemovedBand {
				continue
			}
			box := r.Box.Image().Intersect(dst.Rect)
			if box.Empty() {
				continue
			}
			boxes = append(boxes, box)
			numbered = append(numbered, i+1)
		}
	}

	w := dst.Rect.Dx()
	keep := make([]bool, w)
	for y := 0; y < dst.Rect.Dy(); y++ {
		clear(keep)
		for _, b := range boxes {
			if y >= b.Min.Y && y < b.Max.Y {
				for x := b.Min.X; x < b.Max.X; x++ {
					keep[x] = true
				}
			}
		}
		row := dst.Pix[y*dst.Stride : y*dst.Stride+w*4]
		for x := 0; x < w; x++ {
			if keep[x] {
				continue
			}
			p := row[x*4 : x*4+3]
			for k := range p {
				p[k] = uint8(float64(p[k])*dimOpacity + 255*(1-dimOpacity) + 0.5)
			}
		}
	}

	imagediff.DrawRectangles(dst, boxes, imagediff.BoxStyle{Color: boxRed, Thickness: 2})
	for i, b := range boxes {
		drawLabel(dst, b, strconv.Itoa(numbered[i]))
	}
	return dst
}

// drawLabel draws text in white on a red tab at the box's top-left corner:
// above the box when there is room, inside it otherwise.
func drawLabel(dst *image.NRGBA, box image.Rectangle, text string) {
	const pad = 2
	tw := len(text)*(3*digitScale+digitScale) - digitScale + 2*pad
	th := 5*digitScale + 2*pad
	y := box.Min.Y - th
	if y < 0 {
		y = box.Min.Y
	}
	tab := image.Rect(box.Min.X, y, box.Min.X+tw, y+th)
	fillColor(dst, tab, boxRed)
	x := tab.Min.X + pad
	for _, ch := range text {
		glyph := digitFont[ch-'0']
		for row := 0; row < 5; row++ {
			for col := 0; col < 3; col++ {
				if glyph[row]&(4>>col) == 0 {
					continue
				}
				cell := image.Rect(0, 0, digitScale, digitScale).
					Add(image.Pt(x+col*digitScale, tab.Min.Y+pad+row*digitScale))
				fillColor(dst, cell, labelWhite)
			}
		}
		x += 4 * digitScale
	}
}

// digitFont is a 3×5 bitmap font: one byte per row, the low three bits are
// the columns, most significant bit on the left.
var digitFont = [10][5]byte{
	{7, 5, 5, 5, 7}, // 0
	{2, 6, 2, 2, 7}, // 1
	{7, 1, 7, 4, 7}, // 2
	{7, 1, 7, 1, 7}, // 3
	{5, 5, 7, 1, 1}, // 4
	{7, 4, 7, 1, 7}, // 5
	{7, 4, 7, 5, 7}, // 6
	{7, 1, 1, 1, 1}, // 7
	{7, 5, 7, 5, 7}, // 8
	{7, 5, 7, 1, 7}, // 9
}

// fillColor fills r (clipped to dst) with c.
func fillColor(dst *image.NRGBA, r image.Rectangle, c color.NRGBA) {
	r = r.Intersect(dst.Rect)
	for y := r.Min.Y; y < r.Max.Y; y++ {
		off := dst.PixOffset(r.Min.X, y)
		row := dst.Pix[off : off+r.Dx()*4]
		for x := 0; x < len(row); x += 4 {
			row[x], row[x+1], row[x+2], row[x+3] = c.R, c.G, c.B, c.A
		}
	}
}

// Crop returns a side-by-side before | after image of one region, padded by
// pad pixels and scaled down (never up) to at most maxWidth pixels wide. It
// is what notifications and the AI step are shown.
//
// Region carries a position on one side only (the before side for a removed
// band, the after side otherwise), so the matching position on the other
// side is found by voting over the row hashes around the region. Areas of a
// panel that fall outside its screenshot are light grey.
func Crop(before, after image.Image, region diff.Region, pad, maxWidth int) *image.NRGBA {
	na, nb := cloneNRGBA(before), cloneNRGBA(after)
	src, other := nb, na
	if region.Kind == diff.RegionRemovedBand {
		src, other = na, nb
	}
	box := region.Box.Pad(pad, src.Rect).Image()
	if box.Empty() {
		box = region.Box.Image()
	}
	dy := locate(src, other, box)

	pw, ph := max(box.Dx(), 1), max(box.Dy(), 1)
	canvas := image.NewNRGBA(image.Rect(0, 0, 2*pw+cropGutter, ph))
	fillColor(canvas, canvas.Rect, panelGrey)
	srcPanel := image.Rect(0, 0, pw, ph)
	otherPanel := srcPanel
	if src == nb {
		srcPanel = srcPanel.Add(image.Pt(pw+cropGutter, 0))
	} else {
		otherPanel = otherPanel.Add(image.Pt(pw+cropGutter, 0))
	}
	blit(canvas, srcPanel, src, box.Min)
	blit(canvas, otherPanel, other, box.Min.Add(image.Pt(0, dy)))

	if maxWidth <= 0 || canvas.Rect.Dx() <= maxWidth {
		return canvas
	}
	scale := float64(maxWidth) / float64(canvas.Rect.Dx())
	out := image.NewNRGBA(image.Rect(0, 0, maxWidth, max(1, int(float64(ph)*scale+0.5))))
	xdraw.ApproxBiLinear.Scale(out, out.Rect, canvas, canvas.Rect, xdraw.Src, nil)
	return out
}

// blit copies the part of img starting at from into panel on dst, leaving
// whatever falls outside img untouched.
func blit(dst *image.NRGBA, panel image.Rectangle, img *image.NRGBA, from image.Point) {
	srcRect := image.Rectangle{Min: from, Max: from.Add(panel.Size())}.Intersect(img.Rect)
	if srcRect.Empty() {
		return
	}
	at := panel.Min.Add(srcRect.Min.Sub(from))
	xdraw.Draw(dst, image.Rectangle{Min: at, Max: at.Add(srcRect.Size())}, img, srcRect.Min, xdraw.Src)
}

// locate returns the vertical offset that maps rows around box on src to
// the same content on other, by letting every context row vote for the
// offsets its hash appears at (weighted down when the hash is common). It
// returns 0 when nothing matches.
func locate(src, other *image.NRGBA, box image.Rectangle) int {
	w := min(src.Rect.Dx(), other.Rect.Dx())
	if w == 0 {
		return 0
	}
	rows := map[uint64][]int{}
	for y, h := range hashRows(other, w) {
		rows[h] = append(rows[h], y)
	}
	y0 := max(0, box.Min.Y-cropContext)
	y1 := min(src.Rect.Dy(), box.Max.Y+cropContext)
	window := rowView(src, y0, y1-y0, w)
	votes := map[int]float64{}
	for i, h := range hashRows(window, w) {
		y := y0 + i
		if y >= box.Min.Y && y < box.Max.Y {
			continue
		}
		at := rows[h]
		for _, o := range at {
			votes[o-y] += 1 / float64(len(at))
		}
	}
	best, bestVotes := 0, 0.0
	for d, v := range votes {
		if v > bestVotes || (v == bestVotes && abs(d) < abs(best)) {
			best, bestVotes = d, v
		}
	}
	return best
}
