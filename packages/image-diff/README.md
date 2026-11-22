# image-diff

Pixel-level image comparison for Go, with **bounding boxes around the changed regions**.

The comparison is a bit-exact port of [mapbox/pixelmatch](https://github.com/mapbox/pixelmatch)
v7.2.0. The region extraction on top of it is this package's own — pixelmatch
gives you a diff image and a count, but not "here are the six components that
changed", which is what a visual monitoring system actually needs.

No dependencies outside the standard library.

## Why a port rather than a wrapper

Existing Go pixelmatch ports are thin translations of the metric and stop there.
Porting upstream exactly buys something better than novelty: **upstream's test
fixtures become this package's correctness oracle.** `TestFixtureParity` runs all
12 of upstream's fixture cases and asserts both the diff counts and the rendered
diff images match byte for byte. Anything the port got wrong shows up there
rather than in production.

Ported from commit `c6fee35afac3c52576b2cb424bd1061ab6a4bd06`. Keep the
`pixelmatch_*.go` files structurally aligned with upstream's `index.js` so future
upstream fixes can be applied mechanically.

## Usage

```go
before, _ := png.Decode(f1)
after, _ := png.Decode(f2)

res, err := imagediff.Diff(before, after, &imagediff.DiffOptions{
    Regions: imagediff.DefaultRegionOptions(),
})
if err != nil {
    return err
}

fmt.Printf("%d pixels changed (%.2f%%) in %d regions\n",
    res.DiffPixels, 100*res.Ratio(), len(res.Boxes))

annotated := imagediff.RenderBoxes(after, res.Boxes, imagediff.DefaultBoxStyle())
png.Encode(out, annotated)
```

For the raw upstream-compatible API, use `Pixelmatch` directly:

```go
n, err := imagediff.Pixelmatch(img1.Pix, img2.Pix, diff.Pix, width, height, nil)
```

It takes straight-alpha RGBA8 buffers of length `width*height*4`, exactly like
upstream. `ToNRGBA` normalizes any `image.Image` (paletted, gray, RGB,
premultiplied `*image.RGBA`, sub-images with a non-zero origin) into that layout.

### Options

`Options` mirrors upstream one for one: `Threshold`, `IncludeAA`, `Alpha`,
`AAColor`, `DiffColor`, `DiffColorAlt`, `DiffMask`, `Checkerboard`, `WindowSize`.
See `DefaultOptions` and the upstream README for their meanings.

Two deliberate differences from JavaScript:

- **A zero-valued `Options` is not "use the defaults."** Go cannot distinguish
  `threshold: 0` from `threshold: undefined`, and upstream's tests rely on
  `threshold: 0` being meaningful. Start from `DefaultOptions()` and adjust, or
  pass `nil`.
- **`WindowSize: 0` means disabled** (upstream's `Infinity`), since a 0×0 window
  is meaningless. Any positive value follows upstream's clamping exactly.

`Workers` is a Go addition: the per-pixel comparison splits into horizontal bands
across goroutines for large images. It never changes the result — each band
writes only its own rows, the anti-aliasing detector reads only the immutable
inputs, and the per-worker OKLab cache is pure. `TestParallelMatchesSequential`
and `TestBandSplitMatchesSequential` enforce that.

### Regions

`RegionOptions` controls how changed pixels become boxes:

| Option | Default | Effect |
| --- | --- | --- |
| `BlockSize` | 8 | Grid resolution in pixels. Larger groups more aggressively. |
| `MinBlockPixels` | 1 | Changed pixels a block needs before it counts. Raise to suppress speckle. |
| `MergeGap` | 1 | How many blocks apart two areas can be and still share a box. |
| `MinDiffPixels` | 0 | Drop regions smaller than this. |
| `Padding` | 2 | Pixels of breathing room around each box. |
| `MergeOverlaps` | true | Union boxes that overlap after padding. |

Boxes are tightened onto real changed pixels, not block edges, and returned
sorted top-to-bottom then left-to-right so output is deterministic.

The extraction is **O(width·height + blocks)**: one pass over the mask to build a
block histogram, a separable dilation and a union-find labeling over the grid
(which is `BlockSize²` times smaller than the image), then a scan of only the
changed blocks to tighten each box.

## Command line

```bash
go run ./cmd/imgdiff before.png after.png diff.png 0.1     # upstream-compatible
go run ./cmd/imgdiff -boxes annotated.png before.png after.png
go run ./cmd/imgdiff -json -boxes out.png a.png b.png
```

Exit codes match upstream: 0 identical, 64 usage, 65 dimension mismatch, 66 images differ.

## Testing

```bash
go test -race ./...                      # parity, unit, property, equivalence
go test -run Fuzz -fuzz FuzzPixelmatch   # also FuzzRegions, FuzzToNRGBA
go test -run '^$' -bench . -benchmem
```

- **Parity** — all 12 upstream fixture cases, counts and diff images byte-exact.
- **Unit** — upstream's OKLab toe-correction, issue #127 color pairs, checkerboard
  blending, sliding-window density and error cases, transliterated.
- **Regions** — table tests on hand-built ASCII masks with exact expected
  rectangles, plus properties: every counted diff pixel is covered by some box,
  boxes stay in bounds, results are deterministic, and a larger `MergeGap` never
  increases the box count.
- **Equivalence** — band splits and worker counts must reproduce the sequential
  result byte for byte, on real fixtures and on random images.
- **Fuzz** — three targets over `Pixelmatch`, `Regions` and `ToNRGBA`.

`go test -update` regenerates the golden diff images (upstream's `UPDATE=1`).

## Benchmarks

11th Gen Core i7-1165G7 (laptop, 8 threads), Go 1.26, Node 25. Numbers below are
medians of repeated runs on an otherwise idle machine, with no CPU pinning or
governor control — treat them as indicative, not as a controlled comparison.

### Against upstream

Same workload as upstream's `bench.js`: 7 fixture pairs × 100 iterations,
single-threaded, images decoded before the timer starts in both.

| | median | range (5 runs) |
| --- | --- | --- |
| Node 25 / pixelmatch 7.2.0 (`node bench.js`) | 1.244 s | 1.160 – 1.281 |
| this package, `Workers: 1` (`-bench BenchmarkFixtures -benchtime 100x`) | 1.081 s | 1.055 – 1.138 |

That is roughly **1.15×**, but the two ranges nearly touch — the honest read is
"somewhat faster, same order of magnitude." V8 optimizes this numeric code well.
Note the two timers are not equivalent: Node's figure includes JIT warmup, Go's
does not.

### Scaling and allocation

`BenchmarkPixelmatch`, no diff output, `b.SetBytes(w*h*4)`:

| workload | `Workers: 1` | `Workers: GOMAXPROCS` |
| --- | --- | --- |
| 1920×1080, few changed components | 18.9 ms | 7.9 ms |
| 1920×5000 full page, few changed components | 46.9 ms | 17.9 ms |
| 1920×5000 full page, identical | 18.9 ms | 18.9 ms |

End-to-end (compare + regions + render) on a 1920×5000 full page: **~32 ms**.

The default path (no diff output, no window) is **0 allocs/op**. A small nonzero
`B/op` still shows up in some benchmarks: that is the pooled OKLab cache being
allocated once and amortized over `b.N`, not a per-call allocation.

### The anti-aliasing detector dominates dense diffs

A comparison where *most* pixels differ is far slower than one where a few
components changed — roughly 25 MB/s versus 450+ MB/s single-threaded.
`BenchmarkAntialiasingCost` isolates the cause by running the same images with
and without `IncludeAA`:

| 1920×1080, `Workers: 1` | AA detection on (default) | `IncludeAA: true` | detector's share |
| --- | --- | --- | --- |
| few changed components | 17.9 ms | 7.8 ms | ~56% |
| half the image changed | 335 ms | 35.5 ms | ~89% |

Every counted difference runs the detector over *both* images — up to 16
`brightnessDelta` calls plus two `hasManySiblings` scans per differing pixel — so
cost scales with the number of differences, not the image size. This is inherent
to the algorithm and true of upstream too. It does not affect the monitoring
case, where a handful of components change; it would matter if you ever compared
unrelated images.

## License

This package is a derivative work of pixelmatch, which is ISC licensed —
Copyright (c) 2025, Mapbox. See [LICENSE-pixelmatch](./LICENSE-pixelmatch). The
ported files carry the attribution in their headers.
