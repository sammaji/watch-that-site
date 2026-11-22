package imagediff

import (
	"errors"
	"image"
	"image/draw"
)

// ErrBoundsMismatch reports that the two images passed to Diff have different
// dimensions. Matching upstream pixelmatch, comparison requires equal sizes.
var ErrBoundsMismatch = errors.New("imagediff: image bounds do not match")

// ToNRGBA normalizes any image.Image into a tightly packed, straight-alpha
// *image.NRGBA whose Pix slice is exactly width*height*4 bytes with the origin
// at (0, 0) — the layout Pixelmatch expects.
//
// An *image.NRGBA that already has that layout is returned as-is rather than
// copied, so callers must not mutate the result if they still need the input.
func ToNRGBA(img image.Image) *image.NRGBA {
	b := img.Bounds()
	if src, ok := img.(*image.NRGBA); ok &&
		src.Rect.Min == (image.Point{}) && src.Stride == 4*b.Dx() {
		return src
	}
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Src)
	return dst
}

// Result is the outcome of a Diff.
type Result struct {
	// DiffPixels is the number of mismatched pixels, or the maximum per-window
	// count when Options.WindowSize is set. Anti-aliased pixels are never counted.
	DiffPixels int
	// Width and Height are the compared dimensions.
	Width, Height int
	// TotalPixels is Width*Height.
	TotalPixels int
	// Mask holds one byte per pixel: 0 same, 1 counted diff, 2 excluded
	// anti-aliasing. Row-major, length TotalPixels.
	Mask []uint8
	// Diff is the pixelmatch-style diff image, or nil if RenderDiff was false.
	Diff *image.NRGBA
	// Boxes are the bounding boxes of the changed regions, in image coordinates,
	// sorted top-to-bottom then left-to-right. Nil unless DiffOptions.Regions
	// was set.
	Boxes []image.Rectangle
}

// Ratio is the fraction of pixels that differ, in [0, 1].
func (r *Result) Ratio() float64 {
	if r.TotalPixels == 0 {
		return 0
	}
	return float64(r.DiffPixels) / float64(r.TotalPixels)
}

// DiffOptions configures Diff.
type DiffOptions struct {
	// Pixelmatch configures the underlying comparison. Nil means DefaultOptions.
	Pixelmatch *Options
	// Regions configures bounding-box extraction. Nil disables it, leaving
	// Result.Boxes empty.
	Regions *RegionOptions
	// RenderDiff requests the pixelmatch diff image in Result.Diff.
	RenderDiff bool
}

// Diff compares two images and reports what changed, optionally grouping the
// changed pixels into bounding boxes.
//
// Both images must have the same dimensions; use Result.Boxes with RenderBoxes
// to draw the changed regions over the second image.
func Diff(a, b image.Image, opts *DiffOptions) (*Result, error) {
	if opts == nil {
		opts = &DiffOptions{}
	}
	if a.Bounds().Dx() != b.Bounds().Dx() || a.Bounds().Dy() != b.Bounds().Dy() {
		return nil, ErrBoundsMismatch
	}

	src1 := ToNRGBA(a)
	src2 := ToNRGBA(b)
	width, height := src1.Rect.Dx(), src1.Rect.Dy()

	pmOpts := opts.Pixelmatch
	if pmOpts == nil {
		pmOpts = DefaultOptions()
	}

	var out *image.NRGBA
	var outPix []byte
	if opts.RenderDiff {
		out = image.NewNRGBA(image.Rect(0, 0, width, height))
		outPix = out.Pix
	}

	// The mask is always requested: region extraction reads it, and it is cheap
	// relative to the comparison itself.
	st, err := pixelmatchMask(src1.Pix, src2.Pix, outPix, width, height, pmOpts, true)
	if err != nil {
		return nil, err
	}

	res := &Result{
		DiffPixels:  st.count,
		Width:       width,
		Height:      height,
		TotalPixels: width * height,
		Mask:        st.mask,
		Diff:        out,
	}
	if opts.Regions != nil {
		res.Boxes = Regions(st.mask, width, height, opts.Regions)
	}
	return res, nil
}
