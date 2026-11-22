package imagediff

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"testing"
)

var allFixtures = []string{
	"1a", "1b", "2a", "2b", "3a", "3b", "4a", "4b",
	"5a", "5b", "6a", "6b", "7a", "7b", "8a",
}

func TestToNRGBAProducesTightBuffers(t *testing.T) {
	for _, name := range allFixtures {
		img := readImage(t, name)
		w, h := img.Rect.Dx(), img.Rect.Dy()
		if img.Rect.Min != (image.Point{}) {
			t.Errorf("%s: origin = %v, want (0,0)", name, img.Rect.Min)
		}
		if img.Stride != 4*w {
			t.Errorf("%s: stride = %d, want %d", name, img.Stride, 4*w)
		}
		if len(img.Pix) != w*h*4 {
			t.Errorf("%s: len(Pix) = %d, want %d", name, len(img.Pix), w*h*4)
		}
	}
}

func TestToNRGBAFastPathAvoidsCopy(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	if got := ToNRGBA(src); got != src {
		t.Error("a tightly packed NRGBA at the origin should be returned as-is")
	}
}

func TestToNRGBAExpandsOpaqueSourcesToAlpha255(t *testing.T) {
	// 4a.png is an RGB PNG with no alpha channel; pngjs and ToNRGBA must both
	// present it as fully opaque RGBA.
	img := readImage(t, "4a")
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 255 {
			t.Fatalf("pixel %d: alpha = %d, want 255", i/4, img.Pix[i])
		}
	}
}

func TestToNRGBAHandlesSubImages(t *testing.T) {
	full := readImage(t, "1a")
	crop := image.Rect(10, 20, 50, 60)

	sub := full.SubImage(crop).(*image.NRGBA)
	if sub.Rect.Min == (image.Point{}) || sub.Stride == 4*crop.Dx() {
		t.Fatal("expected a sub-image with a non-zero origin and a wider stride")
	}

	got := ToNRGBA(sub)
	if got.Rect != image.Rect(0, 0, crop.Dx(), crop.Dy()) {
		t.Fatalf("bounds = %v, want %v", got.Rect, image.Rect(0, 0, crop.Dx(), crop.Dy()))
	}

	want := image.NewNRGBA(image.Rect(0, 0, crop.Dx(), crop.Dy()))
	for y := 0; y < crop.Dy(); y++ {
		for x := 0; x < crop.Dx(); x++ {
			want.SetNRGBA(x, y, full.NRGBAAt(crop.Min.X+x, crop.Min.Y+y))
		}
	}
	if !bytes.Equal(got.Pix, want.Pix) {
		t.Error("sub-image was not normalized to the equivalent tight crop")
	}
}

func TestToNRGBAHandlesPremultipliedRGBA(t *testing.T) {
	// image.RGBA is premultiplied while pixelmatch expects straight alpha;
	// ToNRGBA must undo that. 4a is opaque, so the round trip is exact.
	nrgba := readImage(t, "4a")
	premul := image.NewRGBA(nrgba.Rect)
	draw.Draw(premul, premul.Bounds(), nrgba, image.Point{}, draw.Src)

	if got := ToNRGBA(premul); !bytes.Equal(got.Pix, nrgba.Pix) {
		t.Error("premultiplied RGBA did not normalize back to the original straight-alpha bytes")
	}
}

func TestToNRGBAHandlesPalettedAndGray(t *testing.T) {
	// 2a.png is an 8-bit colormap PNG, decoded by Go as *image.Paletted.
	f := mustDecodeFixture(t, "2a")
	if _, ok := f.(*image.Paletted); !ok {
		t.Logf("2a decoded as %T, not *image.Paletted", f)
	}
	got := ToNRGBA(f)
	b := f.Bounds()
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			wr, wg, wb, wa := f.At(b.Min.X+x, b.Min.Y+y).RGBA()
			gr, gg, gb, ga := got.At(x, y).RGBA()
			if wr != gr || wg != gg || wb != gb || wa != ga {
				t.Fatalf("pixel (%d,%d) = %v, want %v", x, y, []uint32{gr, gg, gb, ga}, []uint32{wr, wg, wb, wa})
			}
		}
	}

	gray := image.NewGray(image.Rect(0, 0, 8, 8))
	for i := range gray.Pix {
		gray.Pix[i] = uint8(i * 3)
	}
	g := ToNRGBA(gray)
	if len(g.Pix) != 8*8*4 {
		t.Fatalf("gray: len(Pix) = %d, want %d", len(g.Pix), 8*8*4)
	}
	for i := 3; i < len(g.Pix); i += 4 {
		if g.Pix[i] != 255 {
			t.Fatalf("gray pixel %d: alpha = %d, want 255", i/4, g.Pix[i])
		}
	}
}

func TestDiffRejectsMismatchedBounds(t *testing.T) {
	a := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	b := image.NewNRGBA(image.Rect(0, 0, 4, 5))
	if _, err := Diff(a, b, nil); err != ErrBoundsMismatch {
		t.Errorf("err = %v, want %v", err, ErrBoundsMismatch)
	}
}

func TestDiffResultFields(t *testing.T) {
	img1 := readImage(t, "6a")
	img2 := readImage(t, "6b")
	res, err := Diff(img1, img2, &DiffOptions{
		Pixelmatch: opt(func(o *Options) { o.Threshold = 0.05 }),
		RenderDiff: true,
	})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if res.DiffPixels != 51 {
		t.Errorf("DiffPixels = %d, want 51", res.DiffPixels)
	}
	if res.Width != 256 || res.Height != 256 || res.TotalPixels != 256*256 {
		t.Errorf("dimensions = %dx%d (%d px), want 256x256 (%d px)", res.Width, res.Height, res.TotalPixels, 256*256)
	}
	if want := 51.0 / (256 * 256); res.Ratio() != want {
		t.Errorf("Ratio() = %v, want %v", res.Ratio(), want)
	}
	if len(res.Mask) != res.TotalPixels {
		t.Fatalf("len(Mask) = %d, want %d", len(res.Mask), res.TotalPixels)
	}
	counted := 0
	for _, v := range res.Mask {
		if v&1 == 1 {
			counted++
		}
	}
	if counted != res.DiffPixels {
		t.Errorf("mask holds %d counted diffs, want %d", counted, res.DiffPixels)
	}
	// the rendered diff must be byte-identical to the upstream golden
	if !bytes.Equal(res.Diff.Pix, readImage(t, "6diff").Pix) {
		t.Error("Diff image does not match the 6diff golden")
	}
	if res.Boxes != nil {
		t.Errorf("Boxes = %v, want nil when Regions is unset", res.Boxes)
	}
}

func TestRatioOfEmptyResult(t *testing.T) {
	r := &Result{}
	if r.Ratio() != 0 {
		t.Errorf("Ratio() = %v, want 0", r.Ratio())
	}
}

func mustDecodeFixture(t *testing.T, name string) image.Image {
	t.Helper()
	f := openFixture(t, name)
	defer f.Close()
	img, err := decodePNG(f)
	if err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	return img
}

func TestRenderBoxes(t *testing.T) {
	base := image.NewNRGBA(image.Rect(0, 0, 20, 20))
	for i := range base.Pix {
		base.Pix[i] = 255
	}
	style := BoxStyle{Color: color.NRGBA{R: 255, A: 255}, Thickness: 2}
	rects := []image.Rectangle{image.Rect(4, 4, 12, 12)}

	out := RenderBoxes(base, rects, style)

	// the source must be untouched
	for i := range base.Pix {
		if base.Pix[i] != 255 {
			t.Fatal("RenderBoxes mutated the base image")
		}
	}
	// the stroke sits inside the rectangle edge
	if got := out.NRGBAAt(4, 4); got != style.Color {
		t.Errorf("corner (4,4) = %v, want %v", got, style.Color)
	}
	if got := out.NRGBAAt(5, 5); got != style.Color {
		t.Errorf("inner stroke (5,5) = %v, want %v", got, style.Color)
	}
	// the interior is left alone
	if got := out.NRGBAAt(8, 8); got != (color.NRGBA{255, 255, 255, 255}) {
		t.Errorf("interior (8,8) = %v, want white", got)
	}
	// and so is the area outside the box
	if got := out.NRGBAAt(3, 3); got != (color.NRGBA{255, 255, 255, 255}) {
		t.Errorf("outside (3,3) = %v, want white", got)
	}
	// the far edge is the last row/column inside the rectangle
	if got := out.NRGBAAt(11, 11); got != style.Color {
		t.Errorf("far corner (11,11) = %v, want %v", got, style.Color)
	}
	if got := out.NRGBAAt(12, 12); got != (color.NRGBA{255, 255, 255, 255}) {
		t.Errorf("just outside (12,12) = %v, want white", got)
	}
}

func TestDrawRectanglesClipsAndDegenerates(t *testing.T) {
	dst := image.NewNRGBA(image.Rect(0, 0, 10, 10))
	style := BoxStyle{Color: color.NRGBA{G: 255, A: 255}, Thickness: 3}

	// boxes partly and wholly outside the image, plus one thinner than the
	// stroke and one empty: none of these may panic or escape the buffer
	DrawRectangles(dst, []image.Rectangle{
		image.Rect(-5, -5, 3, 3),
		image.Rect(8, 8, 20, 20),
		image.Rect(4, 4, 5, 9), // 1px wide, thinner than the 3px stroke
		image.Rect(2, 2, 2, 2), // empty
		image.Rect(100, 100, 110, 110),
	}, style)

	if got := dst.NRGBAAt(0, 0); got != style.Color {
		t.Errorf("clipped box did not draw at (0,0): %v", got)
	}
	if got := dst.NRGBAAt(4, 4); got != style.Color {
		t.Errorf("thin box did not draw at (4,4): %v", got)
	}
}

func TestDrawRectanglesZeroThickness(t *testing.T) {
	dst := image.NewNRGBA(image.Rect(0, 0, 6, 6))
	style := BoxStyle{Color: color.NRGBA{B: 255, A: 255}} // Thickness 0 -> 1
	DrawRectangles(dst, []image.Rectangle{image.Rect(1, 1, 5, 5)}, style)

	if got := dst.NRGBAAt(1, 1); got != style.Color {
		t.Errorf("(1,1) = %v, want the stroke color", got)
	}
	if got := dst.NRGBAAt(2, 2); got != (color.NRGBA{}) {
		t.Errorf("(2,2) = %v, want untouched with a 1px stroke", got)
	}
}

// small helpers shared with the fuzz targets
func rect(x0, y0, x1, y1 int) image.Rectangle { return image.Rect(x0, y0, x1, y1) }
func newNRGBA(w, h int) *image.NRGBA          { return image.NewNRGBA(image.Rect(0, 0, w, h)) }

func TestDefaultBoxStyle(t *testing.T) {
	s := DefaultBoxStyle()
	if s.Color != (color.NRGBA{R: 255, A: 255}) {
		t.Errorf("Color = %v, want opaque red", s.Color)
	}
	if s.Thickness != 2 {
		t.Errorf("Thickness = %d, want 2", s.Thickness)
	}
}
