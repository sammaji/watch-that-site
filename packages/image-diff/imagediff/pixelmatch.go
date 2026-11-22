// Ported from mapbox/pixelmatch v7.2.0 (index.js), commit
// c6fee35afac3c52576b2cb424bd1061ab6a4bd06.
//
// Copyright (c) 2025, Mapbox — ISC License (see LICENSE-pixelmatch).
//
// Pixelmatch is a bit-exact transliteration of upstream's default export. The
// structure, names and constants deliberately mirror index.js so upstream fixes
// can be applied mechanically; see pixelmatch_test.go for the parity tests that
// hold it to the upstream fixtures.

package imagediff

import (
	"errors"
	"fmt"
	"sync"
)

// Errors mirroring the three exceptions thrown by upstream pixelmatch.
var (
	// ErrBadPixelData reports a nil image buffer. Upstream throws this when a
	// caller passes something that is not a Uint8Array/Uint8ClampedArray/Buffer;
	// Go's type system rules that out, so only nil remains.
	ErrBadPixelData = errors.New("imagediff: image data: non-nil byte slice expected")
	// ErrSizeMismatch reports that img1, img2 and output are not all the same length.
	ErrSizeMismatch = errors.New("imagediff: image sizes do not match")
	// ErrBadDimensions reports that the buffer length is not width*height*4.
	ErrBadDimensions = errors.New("imagediff: image data size does not match width/height")
)

// Options configures Pixelmatch. A nil *Options means DefaultOptions.
//
// Note that unlike the JavaScript original, a zero-valued struct is not the
// same as an omitted option: Go cannot distinguish `threshold: 0` from
// `threshold: undefined`. Always start from DefaultOptions and adjust, or pass
// nil for the defaults.
type Options struct {
	// Threshold is the matching threshold as a maximum acceptable OKLab HyAB
	// distance (0 to 1); smaller is more sensitive. 1.0 is the distance between
	// black and white. Default 0.1.
	Threshold float64
	// IncludeAA disables anti-aliasing detection when true. Default false.
	IncludeAA bool
	// Alpha is the opacity of the original image in the diff output. Default 0.1.
	Alpha float64
	// AAColor is the color of anti-aliased pixels in the diff output. Default yellow.
	AAColor [3]uint8
	// DiffColor is the color of differing pixels in the diff output. Default red.
	DiffColor [3]uint8
	// DiffColorAlt, when non-nil, colors dark-on-light differences differently
	// from light-on-dark ones. Default nil (all diffs use DiffColor).
	DiffColorAlt *[3]uint8
	// DiffMask draws the diff over a transparent background rather than over the
	// original image. Default false.
	DiffMask bool
	// Checkerboard blends semi-transparent pixels against a checkerboard pattern
	// when comparing, rather than plain white. Default true.
	Checkerboard bool
	// WindowSize, when > 0, makes Pixelmatch return the maximum number of diff
	// pixels found in any N×N sliding window instead of the total count. N is
	// clamped to the image dimensions. Default 0, meaning the total count
	// (upstream's Infinity).
	WindowSize int
	// Workers sets the number of goroutines used for the per-pixel comparison.
	// 0 means GOMAXPROCS, 1 forces sequential. This is a Go addition; it never
	// changes the result. See parallel.go.
	Workers int
}

// DefaultOptions returns the upstream default options.
func DefaultOptions() *Options {
	return &Options{
		Threshold:    0.1,
		Alpha:        0.1,
		AAColor:      [3]uint8{255, 255, 0},
		DiffColor:    [3]uint8{255, 0, 0},
		Checkerboard: true,
	}
}

var cachePool = sync.Pool{New: func() any { return new(oklabCache) }}

// Pixelmatch compares two equally sized images, pixel by pixel.
//
// img1 and img2 are straight-alpha RGBA8 pixel data of length width*height*4.
// output, if non-nil, receives the diff image and must be the same length; it is
// expected to be zeroed, matching the freshly allocated buffers upstream callers
// pass (in DiffMask mode untouched pixels are left as-is).
//
// It returns the number of mismatched pixels, or the maximum per-window count if
// Options.WindowSize is set.
func Pixelmatch(img1, img2, output []byte, width, height int, opts *Options) (int, error) {
	if opts == nil {
		opts = DefaultOptions()
	}
	st, err := pixelmatchMask(img1, img2, output, width, height, opts, opts.WindowSize > 0)
	if err != nil {
		return 0, err
	}
	return st.count, nil
}

// matchState is the internal result of a comparison pass.
type matchState struct {
	count     int
	mask      []uint8 // nil unless wantMask
	firstDiff int
	lastDiff  int
}

// pixelmatchMask is the shared implementation. When wantMask is set — by the
// WindowSize option or by Diff, which needs it for region extraction — a
// per-pixel mask is populated: 0 same/ignored, 1 diff, 2 excluded AA. Diff
// pixels are given odd values so the window scan can count them branchlessly
// with & 1.
func pixelmatchMask(img1, img2, output []byte, width, height int, opts *Options, wantMask bool) (matchState, error) {
	st := matchState{firstDiff: -1}

	if img1 == nil || img2 == nil {
		return st, ErrBadPixelData
	}
	if len(img1) != len(img2) || (output != nil && len(output) != len(img1)) {
		return st, fmt.Errorf("%w. Image 1 size: %d, image 2 size: %d", ErrSizeMismatch, len(img1), len(img2))
	}
	if len(img1) != width*height*4 {
		return st, fmt.Errorf("%w. Expecting %d. Got %d", ErrBadDimensions, width*height*4, len(img1))
	}

	// check if images are identical
	length := width * height
	identical := true
	for i := 0; i < length; i++ {
		if px32(img1, i) != px32(img2, i) {
			identical = false
			break
		}
	}
	if identical { // fast path if identical
		if output != nil && !opts.DiffMask {
			for i, pos := 0, 0; i < length; i, pos = i+1, pos+4 {
				drawGrayPixel(img1, pos, opts.Alpha, output)
			}
		}
		if wantMask {
			st.mask = make([]uint8, length)
		}
		return st, nil
	}

	// maximum acceptable OKLab HyAB distance between two colors;
	// 1.0 is the HyAB distance between black and white
	maxDelta := opts.Threshold

	var mask []uint8
	if wantMask {
		mask = make([]uint8, length)
	}

	res := comparePixels(img1, img2, output, width, height, opts, maxDelta, mask)

	st.count = res.diff
	st.mask = mask
	st.firstDiff = res.firstDiffY
	st.lastDiff = res.lastDiffY

	// return the number of different pixels
	if opts.WindowSize <= 0 {
		return st, nil
	}

	st.count = windowedMax(mask, width, height, opts.WindowSize, res.firstDiffY, res.lastDiffY)
	return st, nil
}

// bandResult is the reduction produced by one comparison band.
type bandResult struct {
	diff       int
	firstDiffY int
	lastDiffY  int
}

// compareBand compares the pixel rows [y0, y1) of the two images, writing into
// output and mask (both indexed globally). It is the body of upstream's main
// comparison loop, restricted to a row range so it can run concurrently; the
// anti-aliasing detector only reads from the immutable inputs, so bands need no
// coordination.
func compareBand(img1, img2, output []byte, width, height int, opts *Options, maxDelta float64, mask []uint8, y0, y1 int, cache *oklabCache) bandResult {
	res := bandResult{firstDiffY: -1}

	aaR, aaG, aaB := opts.AAColor[0], opts.AAColor[1], opts.AAColor[2]
	diffR, diffG, diffB := opts.DiffColor[0], opts.DiffColor[1], opts.DiffColor[2]
	altR, altG, altB := diffR, diffG, diffB
	if opts.DiffColorAlt != nil {
		altR, altG, altB = opts.DiffColorAlt[0], opts.DiffColorAlt[1], opts.DiffColorAlt[2]
	}

	// compare each pixel of one image against the other one
	for i, pos := y0*width, y0*width*4; i < y1*width; i, pos = i+1, pos+4 {
		// whether the HyAB OKLab distance exceeds the threshold:
		// 0 if not, ±1 if yes (negative if img2 pixel is darker)
		delta := 0
		if px32(img1, i) != px32(img2, i) {
			delta = colorDelta(img1, img2, pos, pos, opts.Checkerboard, maxDelta, cache)
		}

		// the color difference is above the threshold
		if delta != 0 {
			x := i % width
			y := i / width
			// check it's a real rendering difference or just anti-aliasing
			isExcludedAA := !opts.IncludeAA &&
				(antialiased(img1, x, y, width, height, img1, img2) ||
					antialiased(img2, x, y, width, height, img2, img1))
			if isExcludedAA {
				// one of the pixels is anti-aliasing; draw as yellow and do not
				// count as difference. Note that we do not include such pixels
				// in a mask.
				if output != nil && !opts.DiffMask {
					drawPixel(output, pos, aaR, aaG, aaB)
				}
				if mask != nil {
					mask[i] = 2
				}

			} else {
				// found substantial difference not caused by anti-aliasing; draw it as such
				if output != nil {
					if delta < 0 {
						drawPixel(output, pos, altR, altG, altB)
					} else {
						drawPixel(output, pos, diffR, diffG, diffB)
					}
				}
				if mask != nil {
					mask[i] = 1
					if res.firstDiffY < 0 {
						res.firstDiffY = y
					}
					res.lastDiffY = y
				}
				res.diff++
			}

		} else if output != nil && !opts.DiffMask {
			// pixels are similar; draw background as grayscale image blended with white
			drawGrayPixel(img1, pos, opts.Alpha, output)
		}
	}

	return res
}

// windowedMax returns the maximum number of diff pixels (mask state 1) over all
// N×N sliding windows, N clamped to the image dimensions.
func windowedMax(mask []uint8, width, height, windowSize, firstDiffY, lastDiffY int) int {
	n := windowSize
	if n > width {
		n = width
	}
	if n > height {
		n = height
	}
	if n < 1 {
		n = 1
	}

	// all diffs were excluded as AA (or there were none)
	if firstDiffY < 0 {
		return 0
	}

	// colSum[x] counts diff pixels in column x over the last n rows; maintained
	// incrementally (add entering row, subtract leaving row), which is why the
	// full mask has to be kept around. Diff pixels are odd (& 1), AA/same even.
	//
	// Upstream uses a Uint16Array here; int32 avoids a wrap that would need an
	// image taller than 65535 px of solid diff to reach.
	colSum := make([]int32, width)
	maxCount := 0
	// running total of all column sums = diff pixels in the current n-row band;
	// an upper bound for any single window, so bands that can't beat maxCount skip
	// the horizontal scan entirely (most bands are sparse or empty)
	bandTotal := 0

	// only rows in [firstDiffY, lastDiffY] hold diffs, so colSum is zero before the
	// first and drained after a leaving row passes the last — bound the scan to the
	// bands that can be nonzero (rows before firstDiffY stay empty, so starting there
	// keeps colSum correct without special initialization)
	yEnd := lastDiffY + n - 1
	if yEnd > height-1 {
		yEnd = height - 1
	}

	for y := firstDiffY; y <= yEnd; y++ {
		rowStart := y * width
		leaving := y - n
		// update column sums: add the entering row, subtract the leaving row
		// (both in one pass over the width)
		if leaving >= 0 {
			leavingStart := leaving * width
			for x := 0; x < width; x++ {
				d := int32(mask[rowStart+x]&1) - int32(mask[leavingStart+x]&1)
				colSum[x] += d
				bandTotal += int(d)
			}
		} else {
			for x := 0; x < width; x++ {
				e := int32(mask[rowStart+x] & 1)
				colSum[x] += e
				bandTotal += int(e)
			}
			// only scan windows that are fully inside vertically
			if y < n-1 {
				continue
			}
		}

		// no window in this band can exceed the total diff count it contains
		if bandTotal <= maxCount {
			continue
		}

		// horizontal running sum over colSum yields every window sum in this band;
		// prime the first n-1 columns, then slide
		windowSum := 0
		for x := 0; x < n-1; x++ {
			windowSum += int(colSum[x])
		}
		for x := n - 1; x < width; x++ {
			windowSum += int(colSum[x])
			if windowSum > maxCount {
				maxCount = windowSum
			}
			windowSum -= int(colSum[x-n+1])
		}
	}

	return maxCount
}
