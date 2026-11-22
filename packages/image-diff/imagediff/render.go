package imagediff

import (
	"image"
	"image/color"
)

// BoxStyle controls how bounding boxes are drawn.
type BoxStyle struct {
	// Color is the stroke color. Written directly, without blending, so a
	// partially transparent color replaces rather than tints what is underneath.
	Color color.NRGBA
	// Thickness is the stroke width in pixels, drawn inward from the box edge.
	// Values below 1 are treated as 1.
	Thickness int
}

// DefaultBoxStyle returns a 2px red outline.
func DefaultBoxStyle() BoxStyle {
	return BoxStyle{Color: color.NRGBA{R: 255, G: 0, B: 0, A: 255}, Thickness: 2}
}

// RenderBoxes returns a copy of base with rects outlined on top of it. base is
// left untouched.
//
// Pass the "after" image and Result.Boxes to get the annotated screenshot: the
// page as it now looks, with every changed region ringed.
func RenderBoxes(base image.Image, rects []image.Rectangle, style BoxStyle) *image.NRGBA {
	src := ToNRGBA(base)
	dst := image.NewNRGBA(image.Rect(0, 0, src.Rect.Dx(), src.Rect.Dy()))
	copy(dst.Pix, src.Pix)
	DrawRectangles(dst, rects, style)
	return dst
}

// DrawRectangles outlines rects on dst in place, clipped to the image bounds.
func DrawRectangles(dst *image.NRGBA, rects []image.Rectangle, style BoxStyle) {
	thickness := max(style.Thickness, 1)
	for _, r := range rects {
		r = r.Intersect(dst.Bounds())
		if r.Empty() {
			continue
		}
		// Top and bottom bands span the full width; they are clamped to the box,
		// so they simply overlap for a box thinner than twice the stroke.
		topEnd := min(r.Min.Y+thickness, r.Max.Y)
		bottomStart := max(r.Max.Y-thickness, r.Min.Y)
		fill(dst, image.Rect(r.Min.X, r.Min.Y, r.Max.X, topEnd), style.Color)
		fill(dst, image.Rect(r.Min.X, bottomStart, r.Max.X, r.Max.Y), style.Color)

		// Side bands cover only what the top and bottom bands did not.
		sideTop, sideBottom := topEnd, bottomStart
		if sideTop < sideBottom {
			leftEnd := min(r.Min.X+thickness, r.Max.X)
			rightStart := max(r.Max.X-thickness, r.Min.X)
			fill(dst, image.Rect(r.Min.X, sideTop, leftEnd, sideBottom), style.Color)
			fill(dst, image.Rect(rightStart, sideTop, r.Max.X, sideBottom), style.Color)
		}
	}
}

func fill(dst *image.NRGBA, r image.Rectangle, c color.NRGBA) {
	r = r.Intersect(dst.Bounds())
	if r.Empty() {
		return
	}
	// Build one row, then copy it down the band.
	first := dst.PixOffset(r.Min.X, r.Min.Y)
	rowLen := r.Dx() * 4
	row := dst.Pix[first : first+rowLen]
	for x := 0; x < rowLen; x += 4 {
		row[x], row[x+1], row[x+2], row[x+3] = c.R, c.G, c.B, c.A
	}
	for y := r.Min.Y + 1; y < r.Max.Y; y++ {
		off := dst.PixOffset(r.Min.X, y)
		copy(dst.Pix[off:off+rowLen], row)
	}
}
