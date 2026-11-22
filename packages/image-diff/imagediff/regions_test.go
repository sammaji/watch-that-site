package imagediff

import (
	"image"
	"math/rand"
	"reflect"
	"testing"
)

// maskFromRows builds a diff mask from an ASCII picture: '#' is a counted diff
// pixel, 'a' an excluded anti-aliased pixel, anything else unchanged.
func maskFromRows(rows ...string) ([]uint8, int, int) {
	height := len(rows)
	width := 0
	for _, r := range rows {
		width = max(width, len(r))
	}
	mask := make([]uint8, width*height)
	for y, r := range rows {
		for x, c := range r {
			switch c {
			case '#':
				mask[y*width+x] = 1
			case 'a':
				mask[y*width+x] = 2
			}
		}
	}
	return mask, width, height
}

func regionOpts(mut func(o *RegionOptions)) *RegionOptions {
	o := DefaultRegionOptions()
	if mut != nil {
		mut(o)
	}
	return o
}

func TestRegions(t *testing.T) {
	tests := []struct {
		name string
		rows []string
		opts *RegionOptions
		want []image.Rectangle
	}{
		{
			name: "empty mask yields no boxes",
			rows: []string{"........", "........"},
			opts: regionOpts(nil),
			want: nil,
		},
		{
			name: "anti-aliased pixels are ignored",
			rows: []string{"..aaa...", "..aaa..."},
			opts: regionOpts(nil),
			want: nil,
		},
		{
			name: "single pixel gives a tight box",
			rows: []string{"........", ".....#..", "........"},
			opts: regionOpts(func(o *RegionOptions) { o.Padding = 0; o.MergeGap = 0 }),
			want: []image.Rectangle{image.Rect(5, 1, 6, 2)},
		},
		{
			name: "box is tightened onto pixels, not block edges",
			rows: []string{
				"................",
				"................",
				"................",
				"......###.......",
				"......###.......",
				"................",
			},
			opts: regionOpts(func(o *RegionOptions) { o.Padding = 0; o.MergeGap = 0 }),
			want: []image.Rectangle{image.Rect(6, 3, 9, 5)},
		},
		{
			name: "blobs further apart than the gap stay separate",
			rows: []string{
				"#.............................................#",
				"................................................",
			},
			opts: regionOpts(func(o *RegionOptions) { o.Padding = 0; o.MergeGap = 1 }),
			want: []image.Rectangle{image.Rect(0, 0, 1, 1), image.Rect(46, 0, 47, 1)},
		},
		{
			name: "blobs within the gap merge into one box",
			rows: []string{
				"#..................#............",
				"................................",
			},
			opts: regionOpts(func(o *RegionOptions) { o.Padding = 0; o.MergeGap = 1 }),
			want: []image.Rectangle{image.Rect(0, 0, 20, 1)},
		},
		{
			name: "MinDiffPixels drops small regions",
			rows: []string{
				"#.............................................#",
				"..............................................#",
				"..............................................#",
			},
			opts: regionOpts(func(o *RegionOptions) {
				o.Padding = 0
				o.MergeGap = 1
				o.MinDiffPixels = 2
			}),
			want: []image.Rectangle{image.Rect(46, 0, 47, 3)},
		},
		{
			name: "padding is clamped to the image bounds",
			rows: []string{"#.......", "........"},
			opts: regionOpts(func(o *RegionOptions) { o.Padding = 4; o.MergeGap = 0 }),
			want: []image.Rectangle{image.Rect(0, 0, 5, 2)},
		},
		{
			name: "MinBlockPixels suppresses sparse blocks",
			rows: []string{
				"#.......###.....",
				"........###.....",
				"........###.....",
			},
			opts: regionOpts(func(o *RegionOptions) {
				o.Padding = 0
				o.MergeGap = 0
				o.MinBlockPixels = 2
			}),
			want: []image.Rectangle{image.Rect(8, 0, 11, 3)},
		},
		{
			name: "boxes are sorted top-to-bottom then left-to-right",
			rows: []string{
				"...............................#",
				"................................",
				"................................",
				"................................",
				"................................",
				"................................",
				"................................",
				"................................",
				"................................",
				"#...............................",
			},
			opts: regionOpts(func(o *RegionOptions) { o.Padding = 0; o.MergeGap = 0 }),
			want: []image.Rectangle{image.Rect(31, 0, 32, 1), image.Rect(0, 9, 1, 10)},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mask, w, h := maskFromRows(tt.rows...)
			got := Regions(mask, w, h, tt.opts)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Regions() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRegionsMergesOverlappingPaddedBoxes(t *testing.T) {
	// Two blobs too far apart to be merged by the block dilation, but whose
	// boxes overlap once padding is applied.
	mask, w, h := maskFromRows(
		"#................#..............",
		"................................",
	)
	opts := regionOpts(func(o *RegionOptions) {
		o.MergeGap = 0
		o.Padding = 0
	})
	if got := len(Regions(mask, w, h, opts)); got != 2 {
		t.Fatalf("without padding: got %d boxes, want 2", got)
	}

	opts.Padding = 10 // 0..10 and 7..27 overlap
	got := Regions(mask, w, h, opts)
	want := []image.Rectangle{image.Rect(0, 0, 28, 2)}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("with padding: Regions() = %v, want %v", got, want)
	}
}

func TestRegionsBlockSizeGrouping(t *testing.T) {
	// A run of separated pixels: a coarser grid groups them, a fine grid does not.
	mask, w, h := maskFromRows(
		"#...#...#...#...",
		"................",
	)
	fine := Regions(mask, w, h, regionOpts(func(o *RegionOptions) {
		o.BlockSize = 1
		o.MergeGap = 0
		o.Padding = 0
	}))
	if len(fine) != 4 {
		t.Errorf("BlockSize=1: got %d boxes, want 4", len(fine))
	}
	coarse := Regions(mask, w, h, regionOpts(func(o *RegionOptions) {
		o.BlockSize = 16
		o.MergeGap = 0
		o.Padding = 0
	}))
	if len(coarse) != 1 {
		t.Errorf("BlockSize=16: got %d boxes, want 1", len(coarse))
	}
}

// randomMask produces a mask with clustered changes, closer to a real screenshot
// diff than uniform noise.
func randomMask(rnd *rand.Rand, w, h, blobs int) []uint8 {
	mask := make([]uint8, w*h)
	for i := 0; i < blobs; i++ {
		cx, cy := rnd.Intn(w), rnd.Intn(h)
		bw, bh := 1+rnd.Intn(20), 1+rnd.Intn(20)
		for y := cy; y < min(cy+bh, h); y++ {
			for x := cx; x < min(cx+bw, w); x++ {
				if rnd.Intn(4) == 0 {
					mask[y*w+x] = 2 // anti-aliased, must never be boxed
				} else {
					mask[y*w+x] = 1
				}
			}
		}
	}
	return mask
}

func TestRegionsProperties(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	const w, h = 200, 150
	bounds := image.Rect(0, 0, w, h)

	for iter := 0; iter < 50; iter++ {
		mask := randomMask(rnd, w, h, 1+rnd.Intn(8))
		opts := regionOpts(func(o *RegionOptions) {
			o.BlockSize = 1 + rnd.Intn(16)
			o.MergeGap = rnd.Intn(3)
			o.Padding = rnd.Intn(4)
		})
		boxes := Regions(mask, w, h, opts)

		// every box lies inside the image
		for _, b := range boxes {
			if !b.In(bounds) {
				t.Fatalf("iter %d: box %v escapes bounds %v", iter, b, bounds)
			}
		}

		// every counted diff pixel is covered by some box
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if mask[y*w+x]&1 == 0 {
					continue
				}
				covered := false
				for _, b := range boxes {
					if (image.Point{X: x, Y: y}).In(b) {
						covered = true
						break
					}
				}
				if !covered {
					t.Fatalf("iter %d: diff pixel (%d,%d) not covered by any of %d boxes", iter, x, y, len(boxes))
				}
			}
		}

		// boxes are sorted deterministically and the call is repeatable
		if !reflect.DeepEqual(boxes, Regions(mask, w, h, opts)) {
			t.Fatalf("iter %d: Regions is not deterministic", iter)
		}
	}
}

func TestRegionsMergeGapMonotonic(t *testing.T) {
	rnd := rand.New(rand.NewSource(7))
	const w, h = 160, 120
	for iter := 0; iter < 20; iter++ {
		mask := randomMask(rnd, w, h, 1+rnd.Intn(6))
		prev := -1
		for gap := 0; gap <= 4; gap++ {
			n := len(Regions(mask, w, h, regionOpts(func(o *RegionOptions) {
				o.MergeGap = gap
				o.Padding = 0
			})))
			if prev >= 0 && n > prev {
				t.Fatalf("iter %d: gap %d produced %d boxes, more than %d at the smaller gap", iter, gap, n, prev)
			}
			prev = n
		}
	}
}

func TestRegionsHandlesDegenerateInput(t *testing.T) {
	if got := Regions(nil, 0, 0, nil); got != nil {
		t.Errorf("empty image: got %v, want nil", got)
	}
	if got := Regions(make([]uint8, 4), 10, 10, nil); got != nil {
		t.Errorf("short mask: got %v, want nil", got)
	}
	// a mask whose width and height are both ragged against the block size
	mask, w, h := maskFromRows("#.......#", ".........", ".........", ".........", ".........")
	got := Regions(mask, w, h, regionOpts(func(o *RegionOptions) {
		o.BlockSize = 4
		o.MergeGap = 0
		o.Padding = 0
	}))
	want := []image.Rectangle{image.Rect(0, 0, 1, 1), image.Rect(8, 0, 9, 1)}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ragged grid: Regions() = %v, want %v", got, want)
	}
}

func TestRegionsFromDiff(t *testing.T) {
	// End to end: the two fixtures differ in one region, which must be boxed.
	img1 := readImage(t, "1a")
	img2 := readImage(t, "1b")
	res, err := Diff(img1, img2, &DiffOptions{
		Pixelmatch: opt(func(o *Options) { o.Threshold = 0.05 }),
		Regions:    DefaultRegionOptions(),
	})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if res.DiffPixels != 154 {
		t.Errorf("DiffPixels = %d, want 154", res.DiffPixels)
	}
	if len(res.Boxes) == 0 {
		t.Fatal("expected at least one bounding box")
	}
	// every counted diff pixel must fall inside a box
	for i, v := range res.Mask {
		if v&1 == 0 {
			continue
		}
		p := image.Point{X: i % res.Width, Y: i / res.Width}
		covered := false
		for _, b := range res.Boxes {
			if p.In(b) {
				covered = true
				break
			}
		}
		if !covered {
			t.Fatalf("diff pixel %v not covered by any box", p)
		}
	}
	t.Logf("1a vs 1b: %d diff pixels in %d regions: %v", res.DiffPixels, len(res.Boxes), res.Boxes)
}

func TestRegionsIgnoresAAOnlyDiff(t *testing.T) {
	// 5a/5b differ only in anti-aliasing, so there is nothing to box.
	img1 := readImage(t, "5a")
	img2 := readImage(t, "5b")
	res, err := Diff(img1, img2, &DiffOptions{
		Pixelmatch: opt(func(o *Options) { o.Threshold = 0.05 }),
		Regions:    DefaultRegionOptions(),
	})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if res.DiffPixels != 0 {
		t.Errorf("DiffPixels = %d, want 0", res.DiffPixels)
	}
	if len(res.Boxes) != 0 {
		t.Errorf("Boxes = %v, want none", res.Boxes)
	}
}
