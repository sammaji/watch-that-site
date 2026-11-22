package imagediff

import (
	"bytes"
	"math/rand"
	"testing"
)

var parityFixtures = [][2]string{
	{"1a", "1b"}, {"2a", "2b"}, {"3a", "3b"}, {"4a", "4b"},
	{"5a", "5b"}, {"6a", "6b"}, {"7a", "7b"}, {"8a", "8b"},
}

// TestBandSplitMatchesSequential exercises the band decomposition directly on
// the real fixtures, at band counts the size heuristic in comparePixels would
// never choose. Band boundaries are the risky part: the anti-aliasing detector
// reads a 3x3 neighbourhood, so a band must still see the rows above and below
// its own.
func TestBandSplitMatchesSequential(t *testing.T) {
	opts := opt(func(o *Options) { o.Threshold = 0.05 })
	cache := new(oklabCache)

	for _, pair := range parityFixtures {
		img1 := readImage(t, pair[0])
		img2 := readImage(t, pair[1])
		width, height := img1.Rect.Dx(), img1.Rect.Dy()
		length := width * height

		wantOut := make([]byte, length*4)
		wantMask := make([]uint8, length)
		want := compareBand(img1.Pix, img2.Pix, wantOut, width, height, opts, opts.Threshold, wantMask, 0, height, cache)

		for _, bands := range []int{2, 3, 5, 7, 64} {
			gotOut := make([]byte, length*4)
			gotMask := make([]uint8, length)
			total := bandResult{firstDiffY: -1}
			rowsPer := (height + bands - 1) / bands
			for b := 0; b < bands; b++ {
				y0 := min(b*rowsPer, height)
				y1 := min(y0+rowsPer, height)
				if y0 >= y1 {
					continue
				}
				r := compareBand(img1.Pix, img2.Pix, gotOut, width, height, opts, opts.Threshold, gotMask, y0, y1, new(oklabCache))
				total.diff += r.diff
				if r.firstDiffY >= 0 {
					if total.firstDiffY < 0 {
						total.firstDiffY = r.firstDiffY
					}
					total.lastDiffY = r.lastDiffY
				}
			}

			if total != want {
				t.Errorf("%s/%s bands=%d: reduction = %+v, want %+v", pair[0], pair[1], bands, total, want)
			}
			if !bytes.Equal(gotOut, wantOut) {
				t.Errorf("%s/%s bands=%d: diff image differs from sequential", pair[0], pair[1], bands)
			}
			if !bytes.Equal(gotMask, wantMask) {
				t.Errorf("%s/%s bands=%d: mask differs from sequential", pair[0], pair[1], bands)
			}
		}
	}
}

// randomImagePair builds two large, partly different images, big enough to trip
// the parallel path in comparePixels.
func randomImagePair(rnd *rand.Rand, width, height int) ([]byte, []byte) {
	img1 := make([]byte, width*height*4)
	rnd.Read(img1)
	// force a mix of opaque and semi-transparent pixels so both colorDelta paths run
	for i := 3; i < len(img1); i += 4 {
		if rnd.Intn(2) == 0 {
			img1[i] = 255
		}
	}
	img2 := make([]byte, len(img1))
	copy(img2, img1)
	// perturb clustered areas rather than uniformly, closer to a real diff
	for blob := 0; blob < 40; blob++ {
		cx, cy := rnd.Intn(width), rnd.Intn(height)
		for y := cy; y < min(cy+30, height); y++ {
			for x := cx; x < min(cx+30, width); x++ {
				p := (y*width + x) * 4
				img2[p] = byte(rnd.Intn(256))
				img2[p+1] = byte(rnd.Intn(256))
				img2[p+2] = byte(rnd.Intn(256))
			}
		}
	}
	return img1, img2
}

func TestParallelMatchesSequential(t *testing.T) {
	rnd := rand.New(rand.NewSource(42))
	const width, height = 600, 500 // 300k pixels, above parallelMinPixels
	img1, img2 := randomImagePair(rnd, width, height)

	base := opt(func(o *Options) { o.Workers = 1 })
	wantOut := make([]byte, len(img1))
	wantCount, err := Pixelmatch(img1, img2, wantOut, width, height, base)
	if err != nil {
		t.Fatalf("sequential: %v", err)
	}
	if wantCount == 0 {
		t.Fatal("test images are identical; the comparison paths would not be exercised")
	}

	for _, workers := range []int{2, 3, 4, 8, 16} {
		o := opt(func(o *Options) { o.Workers = workers })
		gotOut := make([]byte, len(img1))
		gotCount, err := Pixelmatch(img1, img2, gotOut, width, height, o)
		if err != nil {
			t.Fatalf("workers=%d: %v", workers, err)
		}
		if gotCount != wantCount {
			t.Errorf("workers=%d: count = %d, want %d", workers, gotCount, wantCount)
		}
		if !bytes.Equal(gotOut, wantOut) {
			t.Errorf("workers=%d: diff image differs from sequential", workers)
		}
	}
}

func TestParallelMatchesSequentialWindowed(t *testing.T) {
	rnd := rand.New(rand.NewSource(9))
	const width, height = 600, 500
	img1, img2 := randomImagePair(rnd, width, height)

	for _, window := range []int{4, 16, 64} {
		seq := opt(func(o *Options) { o.Workers = 1; o.WindowSize = window })
		want, err := Pixelmatch(img1, img2, nil, width, height, seq)
		if err != nil {
			t.Fatalf("sequential window=%d: %v", window, err)
		}
		par := opt(func(o *Options) { o.Workers = 8; o.WindowSize = window })
		got, err := Pixelmatch(img1, img2, nil, width, height, par)
		if err != nil {
			t.Fatalf("parallel window=%d: %v", window, err)
		}
		if got != want {
			t.Errorf("window=%d: parallel = %d, sequential = %d", window, got, want)
		}
	}
}

// TestDeterminism guards against any ordering dependence creeping into the
// parallel path: repeated runs must be byte-identical.
func TestDeterminism(t *testing.T) {
	rnd := rand.New(rand.NewSource(3))
	const width, height = 600, 500
	img1, img2 := randomImagePair(rnd, width, height)

	first := make([]byte, len(img1))
	firstCount, err := Pixelmatch(img1, img2, first, width, height, nil)
	if err != nil {
		t.Fatalf("Pixelmatch: %v", err)
	}
	for i := 0; i < 5; i++ {
		out := make([]byte, len(img1))
		count, err := Pixelmatch(img1, img2, out, width, height, nil)
		if err != nil {
			t.Fatalf("Pixelmatch: %v", err)
		}
		if count != firstCount || !bytes.Equal(out, first) {
			t.Fatalf("run %d differs from the first run", i)
		}
	}
}
