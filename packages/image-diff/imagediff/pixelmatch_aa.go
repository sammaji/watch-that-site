// Ported from mapbox/pixelmatch v7.2.0 (index.js), commit
// c6fee35afac3c52576b2cb424bd1061ab6a4bd06.
//
// Copyright (c) 2025, Mapbox — ISC License (see LICENSE-pixelmatch).

package imagediff

import "encoding/binary"

// px32 reads pixel i as a packed uint32, standing in for upstream's Uint32Array
// views over the image data. Only equality is ever tested, so the byte order is
// irrelevant as long as it is consistent.
func px32(img []byte, i int) uint32 {
	return binary.LittleEndian.Uint32(img[i*4:])
}

// antialiased checks if a pixel is likely a part of anti-aliasing; based on
// "Anti-aliased Pixel and Intensity Slope Detector" paper by V. Vysniauskas, 2009.
//
// a and b are the byte slices upstream views as a32/b32.
func antialiased(img []byte, x1, y1, width, height int, a, b []byte) bool {
	x0 := x1 - 1
	if x1 <= 0 {
		x0 = 0
	}
	y0 := y1 - 1
	if y1 <= 0 {
		y0 = 0
	}
	x2 := x1 + 1
	if x1 >= width-1 {
		x2 = width - 1
	}
	y2 := y1 + 1
	if y1 >= height-1 {
		y2 = height - 1
	}
	pos4 := (y1*width + x1) * 4
	// cache the center pixel's RGBA once instead of re-reading it on every neighbor comparison
	cr := img[pos4]
	cg := img[pos4+1]
	cb := img[pos4+2]
	ca := img[pos4+3]
	zeroes := 0
	if x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2 {
		zeroes = 1
	}
	var min, max float64
	var minX, minY, maxX, maxY int

	// go through 8 adjacent pixels
	rowStep := width * 4
	for x := x0; x <= x2; x++ {
		m := (y0*width + x) * 4
		for y := y0; y <= y2; y, m = y+1, m+rowStep {
			if x == x1 && y == y1 {
				continue
			}

			// brightness delta between the center pixel and adjacent one
			delta := brightnessDelta(img, m, cr, cg, cb, ca)

			// count the number of equal, darker and brighter adjacent pixels
			if delta == 0 {
				zeroes++
				// if found more than 2 equal siblings, it's definitely not anti-aliasing
				if zeroes > 2 {
					return false
				}

				// remember the darkest pixel
			} else if delta < min {
				min = delta
				minX = x
				minY = y

				// remember the brightest pixel
			} else if delta > max {
				max = delta
				maxX = x
				maxY = y
			}
		}
	}

	// if there are no both darker and brighter pixels among siblings, it's not anti-aliasing
	if min == 0 || max == 0 {
		return false
	}

	// if either the darkest or the brightest pixel has 3+ equal siblings in both images
	// (definitely not anti-aliased), this pixel is anti-aliased
	return (hasManySiblings(a, minX, minY, width, height) && hasManySiblings(b, minX, minY, width, height)) ||
		(hasManySiblings(a, maxX, maxY, width, height) && hasManySiblings(b, maxX, maxY, width, height))
}

// hasManySiblings checks if a pixel has 3+ adjacent pixels of the same color.
func hasManySiblings(img []byte, x1, y1, width, height int) bool {
	pos1 := y1*width + x1
	val := px32(img, pos1)

	if x1 > 0 && x1 < width-1 && y1 > 0 && y1 < height-1 {
		n := b2i(val == px32(img, pos1-width-1)) +
			b2i(val == px32(img, pos1-1)) +
			b2i(val == px32(img, pos1+width-1)) +
			b2i(val == px32(img, pos1-width)) +
			b2i(val == px32(img, pos1+width)) +
			b2i(val == px32(img, pos1-width+1)) +
			b2i(val == px32(img, pos1+1)) +
			b2i(val == px32(img, pos1+width+1))
		return n > 2
	}

	x0 := x1 - 1
	if x1 <= 0 {
		x0 = 0
	}
	y0 := y1 - 1
	if y1 <= 0 {
		y0 = 0
	}
	x2 := x1 + 1
	if x1 >= width-1 {
		x2 = width - 1
	}
	y2 := y1 + 1
	if y1 >= height-1 {
		y2 = height - 1
	}
	zeroes := 0
	if x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2 {
		zeroes = 1
	}

	// go through 8 adjacent pixels
	for x := x0; x <= x2; x++ {
		pos := y0*width + x
		for y := y0; y <= y2; y, pos = y+1, pos+width {
			if x == x1 && y == y1 {
				continue
			}
			zeroes += b2i(val == px32(img, pos))
			if zeroes > 2 {
				return true
			}
		}
	}
	return false
}

func b2i(v bool) int {
	if v {
		return 1
	}
	return 0
}

// brightnessDelta is a specialized brightness-only color delta for the
// anti-aliasing detector, with the center pixel's RGBA hoisted out of the
// neighbor loop.
//
// Intentionally stays on gamma-space Rec.601 luma rather than the OKLab ΔL used
// by colorDelta: the detector only needs a cheap, monotonic scalar to find the
// intensity ramp direction. Semi-transparent pixels are composited over fixed
// white rather than colorDelta's checkerboard, because a ramp structure test
// needs a deterministic background.
func brightnessDelta(img []byte, m int, r1b, g1b, b1b, a1b uint8) float64 {
	r2b := img[m]
	g2b := img[m+1]
	b2b := img[m+2]
	a2b := img[m+3]

	dr := float64(r1b) - float64(r2b)
	dg := float64(g1b) - float64(g2b)
	db := float64(b1b) - float64(b2b)
	da := float64(a1b) - float64(a2b)

	if dr == 0 && dg == 0 && db == 0 && da == 0 {
		return 0
	}

	if a1b < 255 || a2b < 255 {
		a1 := float64(a1b)
		a2 := float64(a2b)
		dr = (float64(r1b)*a1 - float64(r2b)*a2 - 255*da) / 255
		dg = (float64(g1b)*a1 - float64(g2b)*a2 - 255*da) / 255
		db = (float64(b1b)*a1 - float64(b2b)*a2 - 255*da) / 255
		d := dr*0.29889531 + dg*0.58662247 + db*0.11448223
		if d == 0 && da != 0 {
			return da / 2
		}
		return d
	}

	return dr*0.29889531 + dg*0.58662247 + db*0.11448223
}
