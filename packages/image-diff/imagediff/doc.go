// Package imagediff compares two images pixel by pixel and reports what changed,
// both as a count and as bounding boxes around the changed regions.
//
// The comparison is a bit-exact Go port of mapbox/pixelmatch v7.2.0 (commit
// c6fee35afac3c52576b2cb424bd1061ab6a4bd06): the same OKLab HyAB perceptual
// color metric, the same anti-aliasing detector, the same diff rendering and the
// same options. Package tests run against upstream's own fixtures and assert
// both the diff counts and the rendered diff images match byte for byte, so the
// port inherits upstream's correctness rather than re-deriving it. Pixelmatch is
// the low-level entry point and keeps upstream's raw-buffer signature.
//
// On top of that, this package adds what pixelmatch does not have: grouping the
// changed pixels into bounding boxes, which is what makes a diff readable when
// you are watching a web page rather than asserting in a test. Diff is the
// high-level entry point:
//
//	res, err := imagediff.Diff(before, after, &imagediff.DiffOptions{
//		Regions: imagediff.DefaultRegionOptions(),
//	})
//	if err != nil {
//		return err
//	}
//	annotated := imagediff.RenderBoxes(after, res.Boxes, imagediff.DefaultBoxStyle())
//
// The package has no dependencies outside the standard library.
//
// # Anti-aliasing
//
// Browser text rendering shifts subtly between runs (font hinting, GPU versus
// CPU rasterization, subpixel positioning). Anti-aliasing detection is on by
// default and those pixels are never counted or boxed, which is what keeps
// screenshot monitoring from alerting on every glyph. Set Options.IncludeAA to
// count them anyway.
//
// # Concurrency
//
// A Result and the images passed to Diff must not be mutated concurrently with
// the call. Diff and Pixelmatch are otherwise safe for concurrent use, and
// parallelise internally for large images; see Options.Workers.
//
// The comparison is a straight port and carries upstream's ISC license; see
// LICENSE-pixelmatch.
package imagediff
