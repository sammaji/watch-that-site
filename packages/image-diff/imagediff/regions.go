package imagediff

import (
	"image"
	"sort"
)

// RegionOptions configures bounding-box extraction from a diff mask.
//
// The extractor works on a grid of BlockSize×BlockSize blocks rather than raw
// pixels. That is what turns scattered changed pixels into the handful of boxes
// a reviewer actually wants: a changed word becomes one box, not thirty.
type RegionOptions struct {
	// BlockSize is the side length in pixels of a grid block. Larger values
	// group more aggressively and run faster. Default 8.
	BlockSize int
	// MinBlockPixels is how many changed pixels a block needs before it counts
	// as changed. Raising it suppresses isolated speckle. Default 1.
	MinBlockPixels int
	// MergeGap is how many blocks apart two changed areas may be and still end
	// up in the same box (Chebyshev distance, so diagonals count). Default 1.
	MergeGap int
	// MinDiffPixels drops any region containing fewer than this many changed
	// pixels. Default 0, keeping every region.
	MinDiffPixels int
	// Padding expands every box by this many pixels on each side, clamped to the
	// image. Default 2.
	Padding int
	// MergeOverlaps merges boxes that overlap after padding, repeatedly until
	// none do. Default true.
	MergeOverlaps bool
}

// DefaultRegionOptions returns region options tuned for web page screenshots.
func DefaultRegionOptions() *RegionOptions {
	return &RegionOptions{
		BlockSize:      8,
		MinBlockPixels: 1,
		MergeGap:       1,
		MinDiffPixels:  0,
		Padding:        2,
		MergeOverlaps:  true,
	}
}

// Regions groups the changed pixels of a diff mask into bounding boxes.
//
// mask is the per-pixel mask from Result.Mask: only counted diffs (odd values)
// participate, so anti-aliased pixels (2) are ignored just as they are in the
// diff count. The returned rectangles are in image coordinates, sorted
// top-to-bottom then left-to-right, and are deterministic for a given mask.
//
// The whole pass is O(width*height + blocks): one pass over the mask to build
// the block histogram, a separable dilation and a union-find labeling over the
// (BlockSize² times smaller) block grid, then a scan of only the changed blocks
// to tighten each box onto real pixels.
func Regions(mask []uint8, width, height int, opts *RegionOptions) []image.Rectangle {
	if opts == nil {
		opts = DefaultRegionOptions()
	}
	if width <= 0 || height <= 0 || len(mask) < width*height {
		return nil
	}
	blockSize := max(opts.BlockSize, 1)
	minBlockPixels := max(opts.MinBlockPixels, 1)

	gw := (width + blockSize - 1) / blockSize
	gh := (height + blockSize - 1) / blockSize

	// 1. Count changed pixels per block. Iterating block-major keeps this
	// division-free; every mask byte is touched exactly once.
	counts := make([]int32, gw*gh)
	for by := 0; by < gh; by++ {
		yEnd := min((by+1)*blockSize, height)
		row := counts[by*gw : (by+1)*gw]
		for y := by * blockSize; y < yEnd; y++ {
			base := y * width
			for bx := 0; bx < gw; bx++ {
				xEnd := min((bx+1)*blockSize, width)
				var c int32
				for x := bx * blockSize; x < xEnd; x++ {
					c += int32(mask[base+x] & 1)
				}
				row[bx] += c
			}
		}
	}

	// 2. Activate blocks that carry enough change.
	active := make([]bool, gw*gh)
	anyActive := false
	for i, c := range counts {
		if c >= int32(minBlockPixels) {
			active[i] = true
			anyActive = true
		}
	}
	if !anyActive {
		return nil
	}

	// 3. Dilate so areas within MergeGap blocks of each other become connected
	// and therefore land in a single box.
	dilated := active
	if opts.MergeGap > 0 {
		dilated = dilate(active, gw, gh, opts.MergeGap)
	}

	// 4. Label connected components of the dilated grid (8-connected).
	uf := newUnionFind(gw * gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			i := y*gw + x
			if !dilated[i] {
				continue
			}
			if x > 0 && dilated[i-1] {
				uf.union(i, i-1)
			}
			if y > 0 {
				if dilated[i-gw] {
					uf.union(i, i-gw)
				}
				if x > 0 && dilated[i-gw-1] {
					uf.union(i, i-gw-1)
				}
				if x < gw-1 && dilated[i-gw+1] {
					uf.union(i, i-gw+1)
				}
			}
		}
	}

	// 5. Tighten each component onto the real changed pixels. Only originally
	// active blocks are scanned; the dilation is used purely for connectivity, so
	// boxes never grow into empty padding blocks.
	type accumulator struct {
		minX, minY, maxX, maxY int
		pixels                 int
	}
	regionIdx := make([]int32, gw*gh)
	for i := range regionIdx {
		regionIdx[i] = -1
	}
	var accs []accumulator

	for by := 0; by < gh; by++ {
		for bx := 0; bx < gw; bx++ {
			bi := by*gw + bx
			if !active[bi] {
				continue
			}
			root := uf.find(bi)
			idx := regionIdx[root]
			if idx < 0 {
				idx = int32(len(accs))
				regionIdx[root] = idx
				accs = append(accs, accumulator{minX: width, minY: height, maxX: -1, maxY: -1})
			}
			acc := &accs[idx]

			xEnd := min((bx+1)*blockSize, width)
			yEnd := min((by+1)*blockSize, height)
			for y := by * blockSize; y < yEnd; y++ {
				base := y * width
				for x := bx * blockSize; x < xEnd; x++ {
					if mask[base+x]&1 == 0 {
						continue
					}
					if x < acc.minX {
						acc.minX = x
					}
					if x > acc.maxX {
						acc.maxX = x
					}
					if y < acc.minY {
						acc.minY = y
					}
					if y > acc.maxY {
						acc.maxY = y
					}
					acc.pixels++
				}
			}
		}
	}

	// 6. Turn the accumulators into padded, clamped rectangles.
	bounds := image.Rect(0, 0, width, height)
	pad := max(opts.Padding, 0)
	boxes := make([]image.Rectangle, 0, len(accs))
	for _, acc := range accs {
		if acc.maxX < 0 || acc.pixels < opts.MinDiffPixels {
			continue
		}
		r := image.Rect(acc.minX-pad, acc.minY-pad, acc.maxX+1+pad, acc.maxY+1+pad).Intersect(bounds)
		if !r.Empty() {
			boxes = append(boxes, r)
		}
	}

	if opts.MergeOverlaps {
		boxes = mergeOverlapping(boxes)
	}

	sort.Slice(boxes, func(i, j int) bool {
		if boxes[i].Min.Y != boxes[j].Min.Y {
			return boxes[i].Min.Y < boxes[j].Min.Y
		}
		if boxes[i].Min.X != boxes[j].Min.X {
			return boxes[i].Min.X < boxes[j].Min.X
		}
		if boxes[i].Max.Y != boxes[j].Max.Y {
			return boxes[i].Max.Y < boxes[j].Max.Y
		}
		return boxes[i].Max.X < boxes[j].Max.X
	})
	return boxes
}

// dilate expands the set bits of a gw×gh grid by g cells in every direction
// (Chebyshev). It runs as two separable 1-D passes with a sliding count, so it
// is O(gw*gh) regardless of g.
func dilate(src []bool, gw, gh, g int) []bool {
	horizontal := make([]bool, gw*gh)
	for y := 0; y < gh; y++ {
		base := y * gw
		count := 0
		for x := 0; x < g && x < gw; x++ {
			if src[base+x] {
				count++
			}
		}
		for x := 0; x < gw; x++ {
			if in := x + g; in < gw && src[base+in] {
				count++
			}
			horizontal[base+x] = count > 0
			if out := x - g; out >= 0 && src[base+out] {
				count--
			}
		}
	}

	out := make([]bool, gw*gh)
	for x := 0; x < gw; x++ {
		count := 0
		for y := 0; y < g && y < gh; y++ {
			if horizontal[y*gw+x] {
				count++
			}
		}
		for y := 0; y < gh; y++ {
			if in := y + g; in < gh && horizontal[in*gw+x] {
				count++
			}
			out[y*gw+x] = count > 0
			if o := y - g; o >= 0 && horizontal[o*gw+x] {
				count--
			}
		}
	}
	return out
}

// mergeOverlapping unions overlapping rectangles until none overlap. A merged
// rectangle can reach rectangles that neither input touched, so the pass repeats
// to a fixed point; the box count is small by construction (the dilation has
// already merged everything nearby), so the quadratic inner loop is cheap.
func mergeOverlapping(in []image.Rectangle) []image.Rectangle {
	for {
		merged := false
		used := make([]bool, len(in))
		out := make([]image.Rectangle, 0, len(in))
		for i := range in {
			if used[i] {
				continue
			}
			r := in[i]
			for j := i + 1; j < len(in); j++ {
				if used[j] || !r.Overlaps(in[j]) {
					continue
				}
				r = r.Union(in[j])
				used[j] = true
				merged = true
			}
			out = append(out, r)
		}
		in = out
		if !merged {
			return in
		}
	}
}

// unionFind is a disjoint-set forest with union by size and path halving, giving
// effectively constant-time operations.
type unionFind struct {
	parent []int32
	size   []int32
}

func newUnionFind(n int) *unionFind {
	uf := &unionFind{parent: make([]int32, n), size: make([]int32, n)}
	for i := range uf.parent {
		uf.parent[i] = int32(i)
		uf.size[i] = 1
	}
	return uf
}

func (u *unionFind) find(x int) int {
	i := int32(x)
	for u.parent[i] != i {
		u.parent[i] = u.parent[u.parent[i]] // path halving
		i = u.parent[i]
	}
	return int(i)
}

func (u *unionFind) union(a, b int) {
	ra, rb := int32(u.find(a)), int32(u.find(b))
	if ra == rb {
		return
	}
	if u.size[ra] < u.size[rb] {
		ra, rb = rb, ra
	}
	u.parent[rb] = ra
	u.size[ra] += u.size[rb]
}
