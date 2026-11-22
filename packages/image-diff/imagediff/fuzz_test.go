package imagediff

import (
	"bytes"
	"testing"
)

// buildPixels turns arbitrary fuzz bytes into a pixel buffer of exactly the
// required length, repeating or truncating the seed as needed.
func buildPixels(seed []byte, length int) []byte {
	out := make([]byte, length)
	if len(seed) == 0 {
		return out
	}
	for i := 0; i < length; i += len(seed) {
		copy(out[i:], seed)
	}
	return out
}

func FuzzPixelmatch(f *testing.F) {
	f.Add(uint8(1), uint8(1), []byte{0, 0, 0, 255}, []byte{255, 255, 255, 255}, 0.1, false, false, uint8(0))
	f.Add(uint8(8), uint8(8), []byte{1, 2, 3, 4}, []byte{5, 6, 7, 8}, 0.05, true, true, uint8(3))
	f.Add(uint8(3), uint8(5), []byte{0}, []byte{128, 0, 0, 12}, 0.0, false, true, uint8(1))

	f.Fuzz(func(t *testing.T, w, h uint8, seed1, seed2 []byte, threshold float64, includeAA, diffMask bool, window uint8) {
		// keep the images small enough to fuzz quickly
		width := int(w)%64 + 1
		height := int(h)%64 + 1
		length := width * height * 4

		img1 := buildPixels(seed1, length)
		img2 := buildPixels(seed2, length)
		out := make([]byte, length)

		opts := DefaultOptions()
		// NaN would make every comparison false; the port has no defined
		// behaviour there and neither does upstream
		if threshold == threshold {
			opts.Threshold = threshold
		}
		opts.IncludeAA = includeAA
		opts.DiffMask = diffMask
		opts.WindowSize = int(window)

		count, err := Pixelmatch(img1, img2, out, width, height, opts)
		if err != nil {
			t.Fatalf("unexpected error on a well-formed call: %v", err)
		}
		if count < 0 || count > width*height {
			t.Fatalf("count %d out of range for a %dx%d image", count, width, height)
		}

		// an image compared against itself never differs
		self, err := Pixelmatch(img1, img1, nil, width, height, opts)
		if err != nil {
			t.Fatalf("self comparison: %v", err)
		}
		if self != 0 {
			t.Fatalf("self comparison reported %d diff pixels, want 0", self)
		}

		// the result must not depend on whether an output image was requested
		countNoOut, err := Pixelmatch(img1, img2, nil, width, height, opts)
		if err != nil {
			t.Fatalf("without output: %v", err)
		}
		if countNoOut != count {
			t.Fatalf("count without output = %d, want %d", countNoOut, count)
		}

		// and it must not depend on the worker count
		opts.Workers = 4
		countParallel, err := Pixelmatch(img1, img2, nil, width, height, opts)
		if err != nil {
			t.Fatalf("parallel: %v", err)
		}
		if countParallel != count {
			t.Fatalf("parallel count = %d, want %d", countParallel, count)
		}
	})
}

func FuzzRegions(f *testing.F) {
	f.Add(uint8(8), uint8(8), []byte{1, 0, 0, 2, 1}, uint8(8), uint8(1), uint8(2), uint8(0))
	f.Add(uint8(1), uint8(1), []byte{1}, uint8(1), uint8(0), uint8(0), uint8(0))
	f.Add(uint8(37), uint8(11), []byte{0, 0, 1}, uint8(4), uint8(3), uint8(9), uint8(5))

	f.Fuzz(func(t *testing.T, w, h uint8, seed []byte, blockSize, mergeGap, padding, minDiff uint8) {
		width := int(w)%128 + 1
		height := int(h)%128 + 1
		mask := buildPixels(seed, width*height)

		opts := &RegionOptions{
			BlockSize:      int(blockSize)%32 + 1,
			MinBlockPixels: 1,
			MergeGap:       int(mergeGap) % 8,
			MinDiffPixels:  int(minDiff),
			Padding:        int(padding) % 16,
			MergeOverlaps:  true,
		}
		boxes := Regions(mask, width, height, opts)

		bounds := rect(0, 0, width, height)
		for _, b := range boxes {
			if !b.In(bounds) {
				t.Fatalf("box %v escapes bounds %v", b, bounds)
			}
			if b.Empty() {
				t.Fatalf("box %v is empty", b)
			}
		}

		// with no size filter, every counted diff pixel must be covered
		if opts.MinDiffPixels == 0 {
			for i, v := range mask {
				if v&1 == 0 {
					continue
				}
				x, y := i%width, i/width
				covered := false
				for _, b := range boxes {
					if x >= b.Min.X && x < b.Max.X && y >= b.Min.Y && y < b.Max.Y {
						covered = true
						break
					}
				}
				if !covered {
					t.Fatalf("diff pixel (%d,%d) not covered by any of %d boxes", x, y, len(boxes))
				}
			}
		}

		// repeated calls must agree
		again := Regions(mask, width, height, opts)
		if len(again) != len(boxes) {
			t.Fatalf("Regions is not deterministic: %d vs %d boxes", len(again), len(boxes))
		}
		for i := range boxes {
			if again[i] != boxes[i] {
				t.Fatalf("Regions is not deterministic at box %d: %v vs %v", i, again[i], boxes[i])
			}
		}
	})
}

// FuzzToNRGBA checks that normalization never panics or produces a
// wrongly-sized buffer for oddly shaped inputs.
func FuzzToNRGBA(f *testing.F) {
	f.Add(uint8(4), uint8(4), uint8(2), uint8(1), []byte{1, 2, 3, 4})

	f.Fuzz(func(t *testing.T, w, h, cropX, cropY uint8, seed []byte) {
		width := int(w)%64 + 1
		height := int(h)%64 + 1
		src := newNRGBA(width, height)
		copy(src.Pix, buildPixels(seed, len(src.Pix)))

		x0 := int(cropX) % width
		y0 := int(cropY) % height
		sub := src.SubImage(rect(x0, y0, width, height))

		got := ToNRGBA(sub)
		wantW, wantH := width-x0, height-y0
		if got.Rect.Dx() != wantW || got.Rect.Dy() != wantH {
			t.Fatalf("bounds = %v, want %dx%d", got.Rect, wantW, wantH)
		}
		if len(got.Pix) != wantW*wantH*4 {
			t.Fatalf("len(Pix) = %d, want %d", len(got.Pix), wantW*wantH*4)
		}
		if got.Stride != wantW*4 {
			t.Fatalf("stride = %d, want %d", got.Stride, wantW*4)
		}
		// the normalized crop must equal a manual copy of the same region
		want := newNRGBA(wantW, wantH)
		for y := 0; y < wantH; y++ {
			copy(want.Pix[y*wantW*4:(y+1)*wantW*4], src.Pix[(y0+y)*src.Stride+x0*4:])
		}
		if !bytes.Equal(got.Pix, want.Pix) {
			t.Fatal("normalized sub-image does not match the manual crop")
		}
	})
}
