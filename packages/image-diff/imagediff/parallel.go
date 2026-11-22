package imagediff

import (
	"runtime"
	"sync"
)

// parallelMinPixels is the image size below which the sequential path is used
// unconditionally: for small images the goroutine and cache setup costs more
// than the comparison itself.
//
// A var rather than a const only so BenchmarkSmallImageThreshold can lower it
// and measure the parallel path below the cutoff; it is never written at
// runtime. See that benchmark for where the real crossover sits.
var parallelMinPixels = 1 << 18 // 256k pixels, e.g. 512x512

// comparePixels runs the per-pixel comparison over the whole image, splitting it
// into horizontal bands across workers when that is worthwhile.
//
// The split is always safe: each band writes only to its own rows of output and
// mask, and the anti-aliasing detector reads exclusively from the immutable
// input images. The OKLab cache is per-worker and pure, so it can only affect
// speed. The result is therefore identical to the sequential path regardless of
// the worker count — a property enforced by TestParallelMatchesSequential.
func comparePixels(img1, img2, output []byte, width, height int, opts *Options, maxDelta float64, mask []uint8) bandResult {
	workers := opts.Workers
	if workers <= 0 {
		workers = runtime.GOMAXPROCS(0)
	}
	if height < 2 || width*height < parallelMinPixels {
		workers = 1
	}
	if workers > height {
		workers = height
	}

	if workers <= 1 {
		cache := cachePool.Get().(*oklabCache)
		defer cachePool.Put(cache)
		return compareBand(img1, img2, output, width, height, opts, maxDelta, mask, 0, height, cache)
	}

	results := make([]bandResult, workers)
	rowsPer := (height + workers - 1) / workers

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		y0 := w * rowsPer
		y1 := y0 + rowsPer
		if y1 > height {
			y1 = height
		}
		if y0 >= y1 {
			results[w] = bandResult{firstDiffY: -1}
			continue
		}
		wg.Add(1)
		go func(w, y0, y1 int) {
			defer wg.Done()
			cache := cachePool.Get().(*oklabCache)
			defer cachePool.Put(cache)
			results[w] = compareBand(img1, img2, output, width, height, opts, maxDelta, mask, y0, y1, cache)
		}(w, y0, y1)
	}
	wg.Wait()

	// Reduce in band order, which is row order: the first band with a diff holds
	// the smallest firstDiffY, the last holds the largest lastDiffY.
	total := bandResult{firstDiffY: -1}
	for _, r := range results {
		total.diff += r.diff
		if r.firstDiffY >= 0 {
			if total.firstDiffY < 0 {
				total.firstDiffY = r.firstDiffY
			}
			total.lastDiffY = r.lastDiffY
		}
	}
	return total
}
