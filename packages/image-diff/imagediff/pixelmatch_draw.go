// Ported from mapbox/pixelmatch v7.2.0 (index.js), commit
// c6fee35afac3c52576b2cb424bd1061ab6a4bd06.
//
// Copyright (c) 2025, Mapbox — ISC License (see LICENSE-pixelmatch).

package imagediff

func drawPixel(output []byte, pos int, r, g, b uint8) {
	output[pos] = r
	output[pos+1] = g
	output[pos+2] = b
	output[pos+3] = 255
}

// drawGrayPixel draws the background as a grayscale image blended with white.
//
// Upstream stores a fractional value into a Uint8Array/Buffer, which truncates
// toward zero rather than rounding; uint8(int(val)) reproduces that. val is
// always within [0, 255] for alpha in [0, 1], so there is nothing to clamp.
func drawGrayPixel(img []byte, i int, alpha float64, output []byte) {
	val := 255 + (float64(img[i])*0.29889531+float64(img[i+1])*0.58662247+float64(img[i+2])*0.11448223-255)*alpha*float64(img[i+3])/255
	v := uint8(int(val))
	drawPixel(output, i, v, v, v)
}
