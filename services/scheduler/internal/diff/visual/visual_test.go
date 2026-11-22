package visual

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"math/rand/v2"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

const (
	pageW = 1366
	pageH = 3000
)

func basePage(t testing.TB) (image.Image, *image.NRGBA) {
	img, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	return roundTrip(t, img), img
}

// requireNoChange asserts the evidence reports nothing.
func requireNoChange(t *testing.T, ev *diff.VisualEvidence, msg ...any) {
	t.Helper()
	require.Empty(t, ev.Regions, msg...)
	require.Nil(t, ev.Shift, msg...)
	require.Zero(t, ev.AreaRatio, msg...)
	require.Zero(t, ev.ChangedPixels, msg...)
}

func TestCompareSameImage(t *testing.T) {
	a, raw := basePage(t)
	ev := Compare(a, roundTrip(t, raw), Options{})
	requireNoChange(t, ev)
	require.Equal(t, [2]int{pageW, pageH}, ev.SizeBefore)
	require.Equal(t, [2]int{pageW, pageH}, ev.SizeAfter)
	require.Equal(t, pageW*pageH, ev.UnmaskedPixels)
	require.NotNil(t, ev.Regions, "regions serialize as [] rather than null")
}

func TestCompareSubPixelTextIsNoChange(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1, XOff: 0.5})
	require.NotEqual(t, a.Pix, b.Pix, "the fixture must actually differ")

	ev := Compare(roundTrip(t, a), roundTrip(t, b), Options{})
	requireNoChange(t, ev)
}

func TestCompareInsertedBanner(t *testing.T) {
	a, raw := basePage(t)
	b := insertRows(raw, banner(pageW, 48), 100)

	ev := Compare(a, roundTrip(t, b), Options{})
	require.Len(t, ev.Regions, 1)
	r := ev.Regions[0]
	require.Equal(t, diff.RegionInsertedBand, r.Kind)
	require.Equal(t, geom.Rect{0, 100, pageW, 48}, r.Box)
	require.Equal(t, 48*pageW, r.Pixels)
	require.Equal(t, &diff.Shift{FromY: 148, DY: 48}, ev.Shift)

	require.Equal(t, 48*pageW, ev.ChangedPixels)
	require.Equal(t, pageW*(pageH+48), ev.UnmaskedPixels)
	require.InDelta(t, 48.0/3048.0, ev.AreaRatio, 1e-9) // ≈ 1.6 %, the band only
}

func TestCompareRemovedBanner(t *testing.T) {
	a, raw := basePage(t)
	withBanner := insertRows(raw, banner(pageW, 48), 100)

	ev := Compare(roundTrip(t, withBanner), a, Options{})
	require.Len(t, ev.Regions, 1)
	r := ev.Regions[0]
	require.Equal(t, diff.RegionRemovedBand, r.Kind)
	require.Equal(t, geom.Rect{0, 100, pageW, 48}, r.Box, "reported at before coordinates")
	require.Equal(t, &diff.Shift{FromY: 100, DY: -48}, ev.Shift)
	require.InDelta(t, float64(48*pageW)/float64(pageW*pageH), ev.AreaRatio, 1e-9)
}

func TestCompareButtonColourChange(t *testing.T) {
	a, blocksA := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, blocksB := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	br := buttonRect(1)
	recolor(b, br.Image(), blue, green)

	ev := Compare(roundTrip(t, a), roundTrip(t, b), Options{BlocksA: blocksA, BlocksB: blocksB})
	require.Len(t, ev.Regions, 1)
	r := ev.Regions[0]
	require.Equal(t, diff.RegionChanged, r.Kind)
	require.True(t, r.Box.Image().In(br.Pad(4, image.Rect(0, 0, pageW, pageH)).Image()), "box %v hugs button %v", r.Box, br)
	require.Equal(t, []string{"button1"}, r.Blocks, "linked to the button block only")
	require.Nil(t, ev.Shift)
	require.Positive(t, ev.AreaRatio)
	require.Less(t, ev.AreaRatio, 0.01)
}

func TestCompareShiftPlusChange(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	br := buttonRect(2)
	recolor(b, br.Image(), blue, green)
	b = insertRows(b, banner(pageW, 48), 100)

	ev := Compare(a, b, Options{})
	require.Len(t, ev.Regions, 2)
	require.Equal(t, diff.RegionInsertedBand, ev.Regions[0].Kind)
	require.Equal(t, diff.RegionChanged, ev.Regions[1].Kind)
	moved := br.Image().Add(image.Pt(0, 48))
	require.True(t, ev.Regions[1].Box.Image().Overlaps(moved), "change reported at after coordinates")
	require.Equal(t, 48, ev.Shift.DY)
}

func TestCompareMaskedRegionChange(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	clock := image.Rect(900, 20, 1100, 40)
	drawGlyphs(b, rand.New(rand.NewPCG(5, 5)), clock, 0, white, navy)

	unmasked := Compare(a, b, Options{})
	require.NotEmpty(t, unmasked.Regions, "the fixture must change without the mask")

	mask := []geom.Rect{geom.FromImage(clock)}
	ev := Compare(a, b, Options{MasksA: mask, MasksB: mask})
	requireNoChange(t, ev)
	require.Equal(t, pageW*pageH-200*20, ev.UnmaskedPixels)
	requireNoChange(t, Compare(a, b, Options{MasksB: mask}), "one side's mask hides the other side too")
	requireNoChange(t, Compare(a, b, Options{MasksA: mask}), "one side's mask hides the other side too")
}

func TestCompareMaskFollowsShift(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	clock := image.Rect(900, 1000, 1100, 1014)
	drawGlyphs(b, rand.New(rand.NewPCG(5, 5)), clock, 0, ink, white)
	b = insertRows(b, banner(pageW, 48), 100)

	ev := Compare(a, b, Options{
		MasksA: []geom.Rect{geom.FromImage(clock)},
		MasksB: []geom.Rect{geom.FromImage(clock.Add(image.Pt(0, 48)))},
	})
	require.Len(t, ev.Regions, 1, "only the banner: the masks moved with the content")
	require.Equal(t, diff.RegionInsertedBand, ev.Regions[0].Kind)
}

func TestCompareAppendedContent(t *testing.T) {
	a, raw := basePage(t)
	more, _ := drawPage(pageSpec{W: pageW, H: 400, Seed: 2})
	b := stack(raw, more)

	ev := Compare(a, roundTrip(t, b), Options{})
	require.Len(t, ev.Regions, 1)
	require.Equal(t, diff.RegionInsertedBand, ev.Regions[0].Kind)
	require.Equal(t, geom.Rect{0, pageH, pageW, 400}, ev.Regions[0].Box)
	require.Nil(t, ev.Shift)
	require.Equal(t, [2]int{pageW, 3400}, ev.SizeAfter)
}

func TestCompareWidthChange(t *testing.T) {
	a, raw := basePage(t)
	b := widen(raw, 34)

	ev := Compare(a, b, Options{})
	require.Len(t, ev.Regions, 1)
	require.Equal(t, diff.RegionExtraWidth, ev.Regions[0].Kind)
	require.Equal(t, geom.Rect{pageW, 0, 34, pageH}, ev.Regions[0].Box)
	require.InDelta(t, 34.0/1400.0, ev.AreaRatio, 1e-9)

	narrower := Compare(b, a, Options{})
	require.Len(t, narrower.Regions, 1)
	require.Equal(t, geom.Rect{pageW, 0, 34, pageH}, narrower.Regions[0].Box, "before coordinates")
}

func TestCompareInsertedBandLinksBlocks(t *testing.T) {
	a, raw := basePage(t)
	b := insertRows(raw, banner(pageW, 48), 100)

	ev := Compare(a, b, Options{BlocksB: bannerBlocks()})
	require.Equal(t, []string{"banner"}, ev.Regions[0].Blocks)
}

func TestCompareDoesNotMutateInputs(t *testing.T) {
	a, _ := drawPage(pageSpec{W: 400, H: 600, Seed: 3})
	b, _ := drawPage(pageSpec{W: 400, H: 600, Seed: 4})
	aPix, bPix := bytes.Clone(a.Pix), bytes.Clone(b.Pix)
	m := []geom.Rect{{0, 0, 200, 200}}
	Compare(a, b, Options{MasksA: m, MasksB: m})
	require.Equal(t, aPix, a.Pix)
	require.Equal(t, bPix, b.Pix)
}

func TestCompareSubImageInputs(t *testing.T) {
	big, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	sub := big.SubImage(image.Rect(100, 500, 700, 1500))
	ev := Compare(sub, cloneNRGBA(sub), Options{})
	requireNoChange(t, ev)
	require.Equal(t, [2]int{600, 1000}, ev.SizeAfter)
}

func TestDecodeFormats(t *testing.T) {
	img, _ := drawPage(pageSpec{W: 200, H: 100, Seed: 1})
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, img, nil))
	got, err := Decode(buf.Bytes())
	require.NoError(t, err)
	require.Equal(t, image.Rect(0, 0, 200, 100), got.Bounds())

	_, err = Decode([]byte("not an image"))
	require.Error(t, err)
}

func TestRenderDiff(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	br := buttonRect(1)
	recolor(b, br.Image(), blue, green)
	ev := Compare(a, b, Options{})
	require.Len(t, ev.Regions, 1)

	bPix := bytes.Clone(b.Pix)
	out := RenderDiff(b, ev)
	require.Equal(t, b.Rect, out.Rect)
	box := ev.Regions[0].Box
	require.Equal(t, boxRed, out.NRGBAAt(box.X(), box.Y()+box.H()/2), "left edge of the box is red")
	require.Equal(t, b.NRGBAAt(box.X()+box.W()/2, box.Y()+box.H()/2), out.NRGBAAt(box.X()+box.W()/2, box.Y()+box.H()/2), "inside the box is untouched")
	require.Equal(t, color.NRGBA{R: 0xa5, G: 0xaa, B: 0xb4, A: 0xff}, out.NRGBAAt(5, 5), "header navy faded to 40 % over white")
	require.Equal(t, labelWhite, labelPixel(out, box), "the region number is drawn")
	require.Equal(t, bPix, b.Pix, "input untouched")

	same := RenderDiff(b, &diff.VisualEvidence{})
	require.Equal(t, b.Rect, same.Rect)
}

func TestCrop(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	br := buttonRect(1)
	recolor(b, br.Image(), blue, green)
	b = insertRows(b, banner(pageW, 48), 100)
	ev := Compare(a, b, Options{})
	require.Len(t, ev.Regions, 2)

	changed := ev.Regions[1]
	out := Crop(a, b, changed, 24, 1200)
	pw, ph := changed.Box.W()+48, changed.Box.H()+48
	require.Equal(t, image.Rect(0, 0, 2*pw+cropGutter, ph), out.Rect)
	// The before panel found the button 48 px higher: the same pixel of the
	// button is blue before and green after.
	require.Equal(t, blue, out.NRGBAAt(24+2, 24+2))
	require.Equal(t, green, out.NRGBAAt(pw+cropGutter+24+2, 24+2))

	band := Crop(a, b, ev.Regions[0], 24, 1200)
	require.Equal(t, 1200, band.Rect.Dx(), "scaled down to maxWidth")
	fullW := 2*pageW + cropGutter
	require.Equal(t, int(float64(48+24+24)*1200/float64(fullW)+0.5), band.Rect.Dy())

	removed := Crop(b, a, diff.Region{Box: geom.Rect{0, 100, pageW, 48}, Kind: diff.RegionRemovedBand}, 24, 0)
	require.Equal(t, 2*pageW+cropGutter, removed.Rect.Dx(), "maxWidth 0 means no scaling")
	require.Equal(t, orange, removed.NRGBAAt(2, 24+2), "before panel shows the banner")
}

// recolor replaces every from pixel in r with to.
func recolor(img *image.NRGBA, r image.Rectangle, from, to color.NRGBA) {
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			if img.NRGBAAt(x, y) == from {
				img.SetNRGBA(x, y, to)
			}
		}
	}
}

// labelPixel returns a pixel inside the first stroke of the region's number
// tab, which sits above the box.
func labelPixel(img *image.NRGBA, box geom.Rect) color.NRGBA {
	th := 5*digitScale + 4
	return img.NRGBAAt(box.X()+2+digitScale, box.Y()-th+2)
}

func bannerBlocks() []capture.Block {
	return []capture.Block{
		{ID: "nav", Rect: geom.Rect{0, 0, pageW, 60}},
		{ID: "banner", Rect: geom.Rect{0, 100, pageW, 48}},
		{ID: "below", Rect: geom.Rect{0, 160, pageW, 20}},
	}
}

// A position: fixed element (a chat bubble, a dev badge) sits at the same page
// y in both full-page screenshots while the content around it shifts. Its
// rows can match at dy=0 as a short island inside a shifted stretch; the
// island must not split the shift into a removed band plus an inserted band.
func TestCompareFixedElementDoesNotSplitShift(t *testing.T) {
	_, raw := basePage(t)
	// A tall blank stretch, like the padding of a section: its rows only
	// differ where the badge sits.
	white := &image.Uniform{color.NRGBA{255, 255, 255, 255}}
	draw.Draw(raw, image.Rect(0, 1300, pageW, 1600), white, image.Point{}, draw.Src)
	b := insertRows(raw, banner(pageW, 48), 0)
	badge := image.Rect(20, 1400, 58, 1438)
	a := image.NewNRGBA(raw.Bounds())
	draw.Draw(a, a.Bounds(), raw, raw.Bounds().Min, draw.Src)
	// A glyph-like badge: every row differs, so each is unique on its side.
	for _, img := range []*image.NRGBA{a, b} {
		for y := badge.Min.Y; y < badge.Max.Y; y++ {
			shade := uint8(20 + 5*(y-badge.Min.Y))
			draw.Draw(img, image.Rect(badge.Min.X, y, badge.Max.X, y+1), &image.Uniform{color.NRGBA{shade, shade, shade, 255}}, image.Point{}, draw.Src)
		}
	}

	ev := Compare(roundTrip(t, a), roundTrip(t, b), Options{})
	var bands []diff.Region
	for _, r := range ev.Regions {
		if r.Kind == diff.RegionInsertedBand || r.Kind == diff.RegionRemovedBand {
			bands = append(bands, r)
		}
	}
	require.Len(t, bands, 1)
	require.Equal(t, diff.RegionInsertedBand, bands[0].Kind)
	require.Equal(t, 48, ev.Shift.DY)
}
