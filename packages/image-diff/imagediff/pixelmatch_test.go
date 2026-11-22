package imagediff

import (
	"bytes"
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// Parity tests transliterated from mapbox/pixelmatch v7.2.0 test/test.js at
// commit c6fee35afac3c52576b2cb424bd1061ab6a4bd06. The fixtures in
// testdata/fixtures are copied verbatim from upstream. Expected diff counts and
// diff images must match upstream exactly — that equivalence is what lets this
// port inherit upstream's correctness.

var update = flag.Bool("update", false, "rewrite the golden diff images in testdata/fixtures")

func readImage(t testing.TB, name string) *image.NRGBA {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "fixtures", name+".png"))
	if err != nil {
		t.Fatalf("open fixture %s: %v", name, err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
	return ToNRGBA(img)
}

func writeImage(t testing.TB, name string, img *image.NRGBA) {
	t.Helper()
	f, err := os.Create(filepath.Join("testdata", "fixtures", name+".png"))
	if err != nil {
		t.Fatalf("create fixture %s: %v", name, err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatalf("encode fixture %s: %v", name, err)
	}
}

// opt builds an Options from the upstream defaults, applying overrides.
func opt(mut func(o *Options)) *Options {
	o := DefaultOptions()
	if mut != nil {
		mut(o)
	}
	return o
}

func diffTest(t *testing.T, imgPath1, imgPath2, diffPath string, opts *Options, expectedMismatch int) {
	t.Helper()
	name := fmt.Sprintf("comparing %s to %s, %s", imgPath1, imgPath2, diffPath)

	t.Run(name, func(t *testing.T) {
		img1 := readImage(t, imgPath1)
		img2 := readImage(t, imgPath2)
		width, height := img1.Rect.Dx(), img1.Rect.Dy()
		diff := image.NewNRGBA(image.Rect(0, 0, width, height))

		mismatch, err := Pixelmatch(img1.Pix, img2.Pix, diff.Pix, width, height, opts)
		if err != nil {
			t.Fatalf("Pixelmatch with output: %v", err)
		}
		mismatch2, err := Pixelmatch(img1.Pix, img2.Pix, nil, width, height, opts)
		if err != nil {
			t.Fatalf("Pixelmatch without output: %v", err)
		}

		if *update {
			writeImage(t, diffPath, diff)
		} else {
			expectedDiff := readImage(t, diffPath)
			if !bytes.Equal(diff.Pix, expectedDiff.Pix) {
				t.Errorf("diff image does not match golden %s (%d of %d bytes differ)",
					diffPath, countDiffBytes(diff.Pix, expectedDiff.Pix), len(diff.Pix))
			}
		}
		if mismatch != expectedMismatch {
			t.Errorf("number of mismatched pixels = %d, want %d", mismatch, expectedMismatch)
		}
		if mismatch != mismatch2 {
			t.Errorf("number of mismatched pixels without diff = %d, want %d", mismatch2, mismatch)
		}
	})
}

func countDiffBytes(a, b []byte) int {
	n := 0
	for i := range a {
		if i < len(b) && a[i] != b[i] {
			n++
		}
	}
	return n
}

func TestFixtureParity(t *testing.T) {
	options := opt(func(o *Options) { o.Threshold = 0.05 })

	diffTest(t, "1a", "1b", "1diff", options, 154)
	diffTest(t, "1a", "1b", "1diffdefaultthreshold", DefaultOptions(), 120)
	diffTest(t, "1a", "1b", "1diffmask", opt(func(o *Options) {
		o.Threshold = 0.05
		o.IncludeAA = false
		o.DiffMask = true
	}), 154)
	diffTest(t, "1a", "1a", "1emptydiffmask", opt(func(o *Options) {
		o.Threshold = 0
		o.DiffMask = true
	}), 0)
	diffTest(t, "2a", "2b", "2diff", opt(func(o *Options) {
		o.Threshold = 0.05
		o.Alpha = 0.5
		o.AAColor = [3]uint8{0, 192, 0}
		o.DiffColor = [3]uint8{255, 0, 255}
	}), 12821)
	diffTest(t, "3a", "3b", "3diff", options, 220)
	diffTest(t, "4a", "4b", "4diff", options, 36563)
	diffTest(t, "5a", "5b", "5diff", options, 0)
	diffTest(t, "6a", "6b", "6diff", options, 51)
	diffTest(t, "6a", "6a", "6empty", opt(func(o *Options) { o.Threshold = 0 }), 0)
	diffTest(t, "7a", "7b", "7diff", opt(func(o *Options) {
		o.DiffColorAlt = &[3]uint8{0, 255, 0}
	}), 2440)
	diffTest(t, "8a", "5b", "8diff", options, 32896)
}

// match is a convenience wrapper mirroring the JS `match(...)` calls in the
// upstream unit tests.
func match(t *testing.T, img1, img2 []byte, width, height int, opts *Options) int {
	t.Helper()
	n, err := Pixelmatch(img1, img2, nil, width, height, opts)
	if err != nil {
		t.Fatalf("Pixelmatch: %v", err)
	}
	return n
}

func TestOKLabToeCorrectionForNearBlack(t *testing.T) {
	pixel := func(gray uint8) []byte { return []byte{gray, gray, gray, 255} }

	if got := match(t, pixel(0), pixel(13), 1, 1, nil); got != 0 {
		t.Errorf("gray 0 vs 13 = %d, want 0", got)
	}
	if got := match(t, pixel(0), pixel(23), 1, 1, nil); got != 1 {
		t.Errorf("gray 0 vs 23 = %d, want 1", got)
	}
}

func TestOKLabSeparatesIssue127ColorPairs(t *testing.T) {
	// https://github.com/mapbox/pixelmatch/issues/127 — YIQ scored these
	// near-identically; OKLab Lr HyAB separates them. Normalized so
	// black↔white = 1.0, default threshold = 0.1.
	pair := func(r1, g1, b1, r2, g2, b2 uint8) int {
		return match(t, []byte{r1, g1, b1, 255}, []byte{r2, g2, b2, 255}, 1, 1, nil)
	}

	cases := []struct {
		name                   string
		r1, g1, b1, r2, g2, b2 uint8
		want                   int
	}{
		{"very different", 41, 56, 157, 41, 56, 0, 1},
		{"clearly different", 39, 44, 92, 39, 44, 14, 1},
		{"nearly identical", 0, 254, 252, 94, 254, 252, 0},
		{"imperceptible", 0, 254, 252, 47, 254, 252, 0},
	}
	for _, c := range cases {
		if got := pair(c.r1, c.g1, c.b1, c.r2, c.g2, c.b2); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestCheckerboardFalseBlendsAgainstWhite(t *testing.T) {
	// These two pixels are visually identical composited on white but differ on
	// a dark checkerboard.
	img1 := []byte{0, 0, 0, 128}       // 50% transparent black
	img2 := []byte{127, 127, 127, 255} // opaque gray

	if got := match(t, img1, img2, 1, 1, opt(func(o *Options) { o.Checkerboard = false })); got != 0 {
		t.Errorf("checkerboard=false: got %d, want 0", got)
	}
	if got := match(t, img1, img2, 1, 1, nil); got != 1 {
		t.Errorf("checkerboard=true: got %d, want 1", got)
	}
}

func TestWindowSizeMaxOverSlidingWindows(t *testing.T) {
	const w, h = 10, 10
	img1 := bytes.Repeat([]byte{255}, w*h*4)
	img2 := bytes.Repeat([]byte{255}, w*h*4)
	// dense 3×3 block of black diff pixels at (2,2)–(4,4)
	for y := 2; y < 5; y++ {
		for x := 2; x < 5; x++ {
			p := (y*w + x) * 4
			img2[p], img2[p+1], img2[p+2] = 0, 0, 0
		}
	}

	aa := func(window int) *Options {
		return opt(func(o *Options) {
			o.IncludeAA = true
			o.WindowSize = window
		})
	}

	// omitted: total diff count
	if got := match(t, img1, img2, w, h, aa(0)); got != 9 {
		t.Errorf("total = %d, want 9", got)
	}
	// 3×3 window captures the whole block
	if got := match(t, img1, img2, w, h, aa(3)); got != 9 {
		t.Errorf("window 3 = %d, want 9", got)
	}
	// 2×2 window captures at most 4
	if got := match(t, img1, img2, w, h, aa(2)); got != 4 {
		t.Errorf("window 2 = %d, want 4", got)
	}
	// window larger than the image is clamped, still finds all 9
	if got := match(t, img1, img2, w, h, aa(100)); got != 9 {
		t.Errorf("window 100 = %d, want 9", got)
	}
	// identical images return 0 in windowed mode
	if got := match(t, img1, img1, w, h, opt(func(o *Options) { o.WindowSize = 3 })); got != 0 {
		t.Errorf("identical windowed = %d, want 0", got)
	}
}

func TestWindowSizeOnRealFixture(t *testing.T) {
	img1 := readImage(t, "6a")
	img2 := readImage(t, "6b")
	width, height := img1.Rect.Dx(), img1.Rect.Dy()

	win := func(n int) *Options {
		return opt(func(o *Options) {
			o.Threshold = 0.05
			o.WindowSize = n
		})
	}

	total := match(t, img1.Pix, img2.Pix, width, height, win(0))
	if total != 51 { // matches the 6diff fixture test
		t.Fatalf("total = %d, want 51", total)
	}
	// a square window at least as large as the image is the degenerate
	// whole-image window, so it must equal the total count
	if got := match(t, img1.Pix, img2.Pix, width, height, win(width)); got != total {
		t.Errorf("window %d = %d, want %d", width, got, total)
	}
	if got := match(t, img1.Pix, img2.Pix, width, height, win(100000)); got != total {
		t.Errorf("window 100000 = %d, want %d", got, total)
	}
	// smaller windows contain a subset of the diffs, but never more than the total
	if got := match(t, img1.Pix, img2.Pix, width, height, win(32)); got != 29 {
		t.Errorf("window 32 = %d, want 29", got)
	}
	if got := match(t, img1.Pix, img2.Pix, width, height, win(8)); got != 6 {
		t.Errorf("window 8 = %d, want 6", got)
	}
}

func TestErrors(t *testing.T) {
	if _, err := Pixelmatch(make([]byte, 8), make([]byte, 9), nil, 2, 1, nil); err == nil {
		t.Error("expected an error when image sizes do not match")
	}
	if _, err := Pixelmatch(make([]byte, 9), make([]byte, 9), nil, 2, 1, nil); err == nil {
		t.Error("expected an error when image size does not match width and height")
	}
	if _, err := Pixelmatch(nil, make([]byte, 4), nil, 1, 1, nil); err == nil {
		t.Error("expected an error for nil image data")
	}
	arr := make([]byte, 4*20*20)
	if _, err := Pixelmatch(arr, arr, make([]byte, 8), 20, 20, nil); err == nil {
		t.Error("expected an error when the output size does not match")
	}
}

func openFixture(t testing.TB, name string) *os.File {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "fixtures", name+".png"))
	if err != nil {
		t.Fatalf("open fixture %s: %v", name, err)
	}
	return f
}

func decodePNG(f *os.File) (image.Image, error) { return png.Decode(f) }
