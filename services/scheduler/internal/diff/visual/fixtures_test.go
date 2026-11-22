package visual

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math/rand/v2"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// The fixtures are synthetic web pages drawn by code rather than PNGs checked
// in by hand: a header bar, lines of "text" made of glyph-like strokes whose
// tops and bottoms vary (so most rows are unique, as on a real page), blank
// gutters between lines (so many rows are not), and buttons.

var (
	white    = color.NRGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}
	ink      = color.NRGBA{R: 0x22, G: 0x22, B: 0x22, A: 0xff}
	navy     = color.NRGBA{R: 0x1f, G: 0x2a, B: 0x44, A: 0xff}
	blue     = color.NRGBA{R: 0x25, G: 0x63, B: 0xeb, A: 0xff}
	green    = color.NRGBA{R: 0x16, G: 0xa3, B: 0x4a, A: 0xff}
	orange   = color.NRGBA{R: 0xf9, G: 0x73, B: 0x16, A: 0xff}
	sidebarC = color.NRGBA{R: 0xee, G: 0xf2, B: 0xff, A: 0xff}
)

const (
	headerHeight = 60
	lineHeight   = 28
	glyphHeight  = 14
	buttonW      = 120
	buttonH      = 40
	buttonEvery  = 700
	buttonFirstY = 400
)

// pageSpec describes one synthetic page.
type pageSpec struct {
	W, H int
	Seed uint64
	// XOff shifts every glyph horizontally by a sub-pixel amount, drawn with
	// coverage-blended edge pixels, like text rasterized at a 0.5 px offset.
	XOff float64
	// ButtonColor is the fill of the buttons; zero means blue.
	ButtonColor color.NRGBA
}

// buttonRect is the rect of the k-th button.
func buttonRect(k int) geom.Rect {
	return geom.Rect{60, buttonFirstY + k*buttonEvery, buttonW, buttonH}
}

// drawPage renders a page and returns it with its blocks: one per text line
// and one per button.
func drawPage(s pageSpec) (*image.NRGBA, []capture.Block) {
	img := image.NewNRGBA(image.Rect(0, 0, s.W, s.H))
	fillColor(img, img.Rect, white)
	rng := rand.New(rand.NewPCG(s.Seed, 0x5eed))
	var blocks []capture.Block

	fillColor(img, image.Rect(0, 0, s.W, headerHeight), navy)
	drawGlyphs(img, rng, image.Rect(24, 20, 400, 40), 0, white, navy)
	blocks = append(blocks, capture.Block{ID: "header", Tag: "header", Rect: geom.Rect{0, 0, s.W, headerHeight}})

	buttonColor := s.ButtonColor
	if buttonColor == (color.NRGBA{}) {
		buttonColor = blue
	}
	line := 0
	for y := headerHeight + 16; y+lineHeight <= s.H; y += lineHeight {
		if nearButton(y) {
			continue // leave room for the button
		}
		right := s.W - 40 - rng.IntN(s.W/3)
		r := image.Rect(40, y, right, y+glyphHeight)
		drawGlyphs(img, rng, r, s.XOff, ink, white)
		blocks = append(blocks, capture.Block{ID: fmt.Sprintf("p%d", line), Tag: "p", Rect: geom.FromImage(r)})
		line++
	}
	for k := 0; ; k++ {
		br := buttonRect(k)
		if br.Y()+br.H() > s.H {
			break
		}
		fillColor(img, br.Image(), buttonColor)
		label := image.Rect(br.X()+16, br.Y()+13, br.X()+br.W()-16, br.Y()+27)
		drawGlyphs(img, rand.New(rand.NewPCG(uint64(k), 7)), label, 0, white, buttonColor)
		blocks = append(blocks, capture.Block{ID: fmt.Sprintf("button%d", k), Tag: "button", Rect: br})
	}
	return img, blocks
}

// nearButton reports whether a text line starting at y would touch a button.
func nearButton(y int) bool {
	k := max(0, (y-buttonFirstY)/buttonEvery)
	for _, kk := range []int{k - 1, k, k + 1} {
		if kk < 0 {
			continue
		}
		br := buttonRect(kk)
		if y < br.Y()+br.H()+8 && y+lineHeight > br.Y()-8 {
			return true
		}
	}
	return false
}

// drawGlyphs fills r with glyph-like vertical strokes of random width,
// spacing, top and bottom, starting xOff pixels to the right. Stroke edges
// that fall between pixels are blended by coverage.
func drawGlyphs(img *image.NRGBA, rng *rand.Rand, r image.Rectangle, xOff float64, fg, bg color.NRGBA) {
	x := float64(r.Min.X)
	for {
		w := 3 + rng.IntN(5)
		if int(x)+w > r.Max.X {
			return
		}
		top := r.Min.Y + rng.IntN(r.Dy()/3)
		bottom := r.Max.Y - rng.IntN(r.Dy()/3)
		x0, x1 := x+xOff, x+xOff+float64(w)
		for c := int(x0); c <= int(x1); c++ {
			cov := min(float64(c+1), x1) - max(float64(c), x0)
			if cov <= 0 {
				continue
			}
			col := blend(bg, fg, cov)
			for y := top; y < bottom; y++ {
				img.SetNRGBA(c, y, col)
			}
		}
		x += float64(w + 3 + rng.IntN(3))
		if rng.IntN(7) == 0 {
			x += 6 // word gap
		}
	}
}

// blend mixes fg over bg by coverage t in [0, 1].
func blend(bg, fg color.NRGBA, t float64) color.NRGBA {
	mix := func(a, b uint8) uint8 { return uint8(float64(a)*(1-t) + float64(b)*t + 0.5) }
	return color.NRGBA{R: mix(bg.R, fg.R), G: mix(bg.G, fg.G), B: mix(bg.B, fg.B), A: 0xff}
}

// banner draws a full-width promotional banner of height h.
func banner(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	fillColor(img, img.Rect, orange)
	drawGlyphs(img, rand.New(rand.NewPCG(99, 1)), image.Rect(40, h/2-8, w/2, h/2+8), 0, white, orange)
	return img
}

// insertRows returns img with ins spliced in at row y.
func insertRows(img, ins *image.NRGBA, y int) *image.NRGBA {
	w := img.Rect.Dx()
	out := image.NewNRGBA(image.Rect(0, 0, w, img.Rect.Dy()+ins.Rect.Dy()))
	stride := w * 4
	copy(out.Pix, img.Pix[:y*stride])
	copy(out.Pix[y*stride:], ins.Pix)
	copy(out.Pix[(y+ins.Rect.Dy())*stride:], img.Pix[y*stride:])
	return out
}

// stack returns top with bottom appended below it.
func stack(top, bottom *image.NRGBA) *image.NRGBA {
	return insertRows(top, bottom, top.Rect.Dy())
}

// widen returns img with extra columns of a sidebar colour on the right.
func widen(img *image.NRGBA, extra int) *image.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	out := image.NewNRGBA(image.Rect(0, 0, w+extra, h))
	fillColor(out, out.Rect, sidebarC)
	for y := 0; y < h; y++ {
		copy(out.Pix[y*out.Stride:], img.Pix[y*img.Stride:(y+1)*img.Stride])
	}
	return out
}

// roundTrip encodes img as PNG and decodes it with Decode, so the golden
// tests run on real PNG fixtures.
func roundTrip(t testing.TB, img image.Image) image.Image {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	out, err := Decode(buf.Bytes())
	require.NoError(t, err)
	return out
}
