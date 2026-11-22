package imagediff

import (
	"fmt"
	"image"
	"math/rand"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

// BenchmarkFixtures runs the seven fixture pairs at the default options with no
// diff output, on real images rather than synthetic ones.
//
// The workers=1 arm is the one that mirrors upstream's bench.js, so only that
// number is comparable against `node bench.js`.
//
// Every fixture is below parallelMinPixels — the largest, 7a at 500x500, misses
// the cutoff by 12,144 pixels — so workers=max runs byte-identical code to
// workers=1 and the two arms measure the same thing. That is the honest picture
// of what these images do in production, and the reason for the third arm:
// gate=off lowers the cutoff so the parallel path is actually reachable,
// showing what the fixtures would gain if the threshold were tuned down.
func BenchmarkFixtures(b *testing.B) {
	type pair struct {
		img1, img2    *image.NRGBA
		width, height int
	}
	var pairs []pair
	for i := 1; i <= 7; i++ {
		img1 := readImage(b, fmt.Sprintf("%da", i))
		img2 := readImage(b, fmt.Sprintf("%db", i))
		pairs = append(pairs, pair{img1, img2, img1.Rect.Dx(), img1.Rect.Dy()})
	}

	var bytesPerOp int64
	for _, p := range pairs {
		bytesPerOp += int64(p.width * p.height * 4)
	}

	arms := []struct {
		workers   int
		lowerGate bool
	}{
		{1, false}, // upstream-comparable
		{0, false}, // GOMAXPROCS as production has it: gated back to sequential
		{0, true},  // GOMAXPROCS with the size gate lifted
	}

	for _, arm := range arms {
		name := fmt.Sprintf("workers=%s", workerLabel(arm.workers))
		if arm.lowerGate {
			name += "/gate=off"
		}
		b.Run(name, func(b *testing.B) {
			if arm.lowerGate {
				saved := parallelMinPixels
				parallelMinPixels = 1
				defer func() { parallelMinPixels = saved }()
			}

			opts := DefaultOptions()
			opts.Workers = arm.workers
			b.SetBytes(bytesPerOp)
			b.ReportAllocs()
			b.ResetTimer()

			sum := 0
			for i := 0; i < b.N; i++ {
				for _, p := range pairs {
					n, err := Pixelmatch(p.img1.Pix, p.img2.Pix, nil, p.width, p.height, opts)
					if err != nil {
						b.Fatal(err)
					}
					sum += n
				}
			}
			runtime.KeepAlive(sum)
		})
	}
}

type benchSize struct {
	name          string
	width, height int
}

// The full-page size is the one that matters for web monitoring: a tall
// screenshot of an entire scrolled page.
var benchSizes = []benchSize{
	{"800x600", 800, 600},
	{"1920x1080", 1920, 1080},
	{"1920x5000_fullpage", 1920, 5000},
	{"3840x2160_4k", 3840, 2160},
}

// syntheticPair builds a photo-like base image and a copy changed according to
// the named scenario.
func syntheticPair(width, height int, scenario string) ([]byte, []byte) {
	rnd := rand.New(rand.NewSource(int64(width*31 + height)))
	img1 := make([]byte, width*height*4)
	// smooth gradients with noise: compresses like a real screenshot and keeps
	// the OKLab cache hit rate realistic rather than pathological
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			p := (y*width + x) * 4
			img1[p] = uint8((x*255/width + rnd.Intn(8)) & 0xff)
			img1[p+1] = uint8((y*255/height + rnd.Intn(8)) & 0xff)
			img1[p+2] = uint8(((x+y)*255/(width+height) + rnd.Intn(8)) & 0xff)
			img1[p+3] = 255
		}
	}

	img2 := make([]byte, len(img1))
	copy(img2, img1)

	switch scenario {
	case "identical":
	case "sparse":
		// a few changed UI components, the common monitoring case
		for blob := 0; blob < 12; blob++ {
			bx, by := rnd.Intn(width), rnd.Intn(height)
			for y := by; y < min(by+40, height); y++ {
				for x := bx; x < min(bx+120, width); x++ {
					p := (y*width + x) * 4
					img2[p], img2[p+1], img2[p+2] = 0, 0, 0
				}
			}
		}
	case "sparse_scaled":
		// "sparse" with the blobs sized relative to the image instead of fixed at
		// 120x40, which at small dimensions is clipped to the whole frame and
		// silently turns the sparse case into the dense one. 12 blobs of
		// (width/16)x(height/27) is 12/432 = 2.78% of the image at any size, the
		// same density "sparse" has at the 1920x1080 reference size.
		bw, bh := max(2, width/16), max(2, height/27)
		for blob := 0; blob < 12; blob++ {
			bx, by := rnd.Intn(width), rnd.Intn(height)
			for y := by; y < min(by+bh, height); y++ {
				for x := bx; x < min(bx+bw, width); x++ {
					p := (y*width + x) * 4
					img2[p], img2[p+1], img2[p+2] = 0, 0, 0
				}
			}
		}
	case "dense":
		// half the image changed, the worst realistic case
		for y := 0; y < height/2; y++ {
			for x := 0; x < width; x++ {
				p := (y*width + x) * 4
				img2[p] = ^img2[p]
				img2[p+1] = ^img2[p+1]
				img2[p+2] = ^img2[p+2]
			}
		}
	}
	return img1, img2
}

func BenchmarkPixelmatch(b *testing.B) {
	for _, size := range benchSizes {
		for _, scenario := range []string{"identical", "sparse", "dense"} {
			img1, img2 := syntheticPair(size.width, size.height, scenario)
			for _, withOutput := range []bool{false, true} {
				for _, workers := range []int{1, 0} { // 0 means GOMAXPROCS
					name := fmt.Sprintf("%s/%s/output=%v/workers=%s",
						size.name, scenario, withOutput, workerLabel(workers))
					b.Run(name, func(b *testing.B) {
						opts := DefaultOptions()
						opts.Workers = workers
						var out []byte
						if withOutput {
							out = make([]byte, len(img1))
						}
						b.SetBytes(int64(size.width * size.height * 4))
						b.ReportAllocs()
						b.ResetTimer()
						for i := 0; i < b.N; i++ {
							if _, err := Pixelmatch(img1, img2, out, size.width, size.height, opts); err != nil {
								b.Fatal(err)
							}
						}
					})
				}
			}
		}
	}
}

func workerLabel(w int) string {
	if w == 0 {
		return fmt.Sprintf("max%d", runtime.GOMAXPROCS(0))
	}
	return fmt.Sprint(w)
}

// BenchmarkRegions measures bounding-box extraction alone, on the mask a real
// comparison would produce.
func BenchmarkRegions(b *testing.B) {
	for _, size := range benchSizes {
		for _, scenario := range []string{"sparse", "dense"} {
			img1, img2 := syntheticPair(size.width, size.height, scenario)
			st, err := pixelmatchMask(img1, img2, nil, size.width, size.height, DefaultOptions(), true)
			if err != nil {
				b.Fatal(err)
			}
			opts := DefaultRegionOptions()
			b.Run(fmt.Sprintf("%s/%s", size.name, scenario), func(b *testing.B) {
				b.SetBytes(int64(size.width * size.height))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if boxes := Regions(st.mask, size.width, size.height, opts); boxes == nil && scenario != "identical" {
						b.Fatal("expected boxes")
					}
				}
			})
		}
	}
}

// BenchmarkDiff is the end-to-end path a caller actually uses: compare, extract
// regions, render the annotated image. Decoding is excluded.
func BenchmarkDiff(b *testing.B) {
	for _, size := range benchSizes {
		img1, img2 := syntheticPair(size.width, size.height, "sparse")
		a := &image.NRGBA{Pix: img1, Stride: size.width * 4, Rect: image.Rect(0, 0, size.width, size.height)}
		c := &image.NRGBA{Pix: img2, Stride: size.width * 4, Rect: image.Rect(0, 0, size.width, size.height)}
		opts := &DiffOptions{Regions: DefaultRegionOptions()}
		style := DefaultBoxStyle()

		b.Run(size.name, func(b *testing.B) {
			b.SetBytes(int64(size.width * size.height * 4))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				res, err := Diff(a, c, opts)
				if err != nil {
					b.Fatal(err)
				}
				RenderBoxes(c, res.Boxes, style)
			}
		})
	}
}

// smallBenchSizes brackets parallelMinPixels (262,144) from well below it up to
// the boundary itself. Every size in benchSizes is above the cutoff, so without
// these the sequential fallback is never measured.
var smallBenchSizes = []benchSize{
	{"64x64_4k", 64, 64},
	{"128x128_16k", 128, 128},
	{"256x256_65k", 256, 256},
	{"512x256_131k", 512, 256},
	{"512x512_262k", 512, 512},
}

// BenchmarkSmallImageThreshold finds where per-image parallelism starts paying
// for itself, which is the empirical justification for parallelMinPixels.
//
// Below the cutoff comparePixels forces workers to 1, so workers=0 and
// workers=1 would otherwise run identical code and the sweep would measure
// nothing. This lowers the cutoff for the duration so both paths are reachable.
//
// Read it as: the smallest size at which workers=max beats workers=1 is where
// the threshold belongs. Note the two scenarios disagree, and that is the
// point — under identical the bit-compare fast path is memory-bandwidth bound
// and extra cores cannot help at any size, which is the case that argues for
// keeping a threshold rather than removing it.
func BenchmarkSmallImageThreshold(b *testing.B) {
	saved := parallelMinPixels
	parallelMinPixels = 1
	defer func() { parallelMinPixels = saved }()

	for _, size := range smallBenchSizes {
		for _, scenario := range []string{"identical", "sparse_scaled"} {
			img1, img2 := syntheticPair(size.width, size.height, scenario)
			for _, workers := range []int{1, 0} { // 0 means GOMAXPROCS
				name := fmt.Sprintf("%s/%s/workers=%s", size.name, scenario, workerLabel(workers))
				b.Run(name, func(b *testing.B) {
					opts := DefaultOptions()
					opts.Workers = workers
					b.SetBytes(int64(size.width * size.height * 4))
					b.ReportAllocs()
					b.ResetTimer()
					for i := 0; i < b.N; i++ {
						if _, err := Pixelmatch(img1, img2, nil, size.width, size.height, opts); err != nil {
							b.Fatal(err)
						}
					}
				})
			}
		}
	}
}

// concurrentBenchWorkloads are the batch shapes BenchmarkConcurrentDiffs runs.
// Both sizes are above parallelMinPixels, which is required: the intra_image arm
// has to actually go parallel for the comparison to mean anything. The counts
// are chosen to keep peak pixel data around 60-130 MB.
var concurrentBenchWorkloads = []struct {
	benchSize
	jobs int
}{
	{benchSize{"800x600", 800, 600}, 16},
	{benchSize{"1920x1080", 1920, 1080}, 8},
}

// BenchmarkConcurrentDiffs answers the question a caller with many images to
// compare actually has: is it better to run one diff across every core, or many
// diffs each pinned to one core?
//
// Everything else in this file times a single call, which cannot distinguish the
// two. Here a fixed batch of independent pairs is run to completion both ways.
// Per-job concurrency tends to win because only the per-pixel comparison
// parallelises — Regions and RenderBoxes are sequential, so cores idle during
// them in the intra_image arm, while independent jobs keep them busy.
//
// The semaphore lives here rather than in the library on purpose: how many
// images to diff at once is the caller's decision, and Diff stays a single-pair
// API.
func BenchmarkConcurrentDiffs(b *testing.B) {
	for _, w := range concurrentBenchWorkloads {
		type job struct{ before, after *image.NRGBA }
		jobs := make([]job, w.jobs)
		for i := range jobs {
			// Vary the dimensions slightly so syntheticPair's size-derived seed
			// gives each job different content rather than one image reused.
			img1, img2 := syntheticPair(w.width+i, w.height, "sparse")
			rect := image.Rect(0, 0, w.width+i, w.height)
			jobs[i] = job{
				before: &image.NRGBA{Pix: img1, Stride: (w.width + i) * 4, Rect: rect},
				after:  &image.NRGBA{Pix: img2, Stride: (w.width + i) * 4, Rect: rect},
			}
		}

		run := func(j job, workers int) int {
			opts := DefaultOptions()
			opts.Workers = workers
			res, err := Diff(j.before, j.after, &DiffOptions{
				Pixelmatch: opts,
				Regions:    DefaultRegionOptions(),
			})
			if err != nil {
				panic(err)
			}
			return len(res.Boxes)
		}

		perDiff := func(b *testing.B) {
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*w.jobs), "ns/diff")
		}

		// Arm A: one job at a time, each using every core.
		b.Run(fmt.Sprintf("%s/jobs=%d/intra_image", w.name, w.jobs), func(b *testing.B) {
			sink := 0
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				for _, j := range jobs {
					sink += run(j, 0) // 0 means GOMAXPROCS
				}
			}
			b.StopTimer()
			perDiff(b)
			runtime.KeepAlive(sink)
		})

		// Arm B: several jobs in flight, each strictly sequential.
		procs := runtime.GOMAXPROCS(0)
		for _, pool := range []int{2, 4, procs, 2 * procs} {
			b.Run(fmt.Sprintf("%s/jobs=%d/per_job/pool=%d", w.name, w.jobs, pool), func(b *testing.B) {
				var sink atomic.Int64
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					sem := make(chan struct{}, pool)
					var wg sync.WaitGroup
					for _, j := range jobs {
						wg.Add(1)
						sem <- struct{}{}
						go func(j job) {
							defer wg.Done()
							defer func() { <-sem }()
							sink.Add(int64(run(j, 1)))
						}(j)
					}
					wg.Wait()
				}
				b.StopTimer()
				perDiff(b)
				runtime.KeepAlive(sink.Load())
			})
		}
	}
}

// BenchmarkAntialiasingCost isolates why a comparison where most pixels differ
// is so much slower than one where a few components changed: every counted
// difference runs the anti-aliasing detector over both images, which is up to
// 16 brightnessDelta calls plus two hasManySiblings scans per pixel. Setting
// IncludeAA skips that entirely, so the gap between the two is the detector's
// share of the runtime.
func BenchmarkAntialiasingCost(b *testing.B) {
	const width, height = 1920, 1080
	for _, scenario := range []string{"sparse", "dense"} {
		img1, img2 := syntheticPair(width, height, scenario)
		for _, includeAA := range []bool{false, true} {
			b.Run(fmt.Sprintf("%s/includeAA=%v", scenario, includeAA), func(b *testing.B) {
				opts := DefaultOptions()
				opts.Workers = 1
				opts.IncludeAA = includeAA
				b.SetBytes(int64(width * height * 4))
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if _, err := Pixelmatch(img1, img2, nil, width, height, opts); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
