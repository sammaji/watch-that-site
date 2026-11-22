// Package geom holds the rectangle type shared by Captures, Monitor rules and
// Change evidence. Rectangles travel as JSON arrays `[x, y, w, h]` in page
// (screenshot) pixels, which is the shape the browser worker emits.
package geom

import "image"

// Rect is `[x, y, w, h]` in screenshot pixels.
type Rect [4]int

// X, Y, W and H name the four components.
func (r Rect) X() int { return r[0] }
func (r Rect) Y() int { return r[1] }
func (r Rect) W() int { return r[2] }
func (r Rect) H() int { return r[3] }

// Area is w*h, or 0 for a degenerate rectangle.
func (r Rect) Area() int {
	if r[2] <= 0 || r[3] <= 0 {
		return 0
	}
	return r[2] * r[3]
}

// Empty reports whether the rectangle covers no pixels.
func (r Rect) Empty() bool { return r.Area() == 0 }

// Image converts to an image.Rectangle (min inclusive, max exclusive).
func (r Rect) Image() image.Rectangle {
	return image.Rect(r[0], r[1], r[0]+r[2], r[1]+r[3])
}

// FromImage converts an image.Rectangle back to a Rect.
func FromImage(ir image.Rectangle) Rect {
	ir = ir.Canon()
	return Rect{ir.Min.X, ir.Min.Y, ir.Dx(), ir.Dy()}
}

// Intersects reports whether the two rectangles share at least one pixel.
func (r Rect) Intersects(o Rect) bool {
	return r.Image().Overlaps(o.Image())
}

// Union returns the smallest rectangle covering both. An empty operand is
// ignored.
func (r Rect) Union(o Rect) Rect {
	switch {
	case r.Empty():
		return o
	case o.Empty():
		return r
	}
	return FromImage(r.Image().Union(o.Image()))
}

// Pad grows the rectangle by p pixels on every side and clamps it to bounds.
func (r Rect) Pad(p int, bounds image.Rectangle) Rect {
	grown := image.Rect(r[0]-p, r[1]-p, r[0]+r[2]+p, r[1]+r[3]+p)
	return FromImage(grown.Intersect(bounds))
}
