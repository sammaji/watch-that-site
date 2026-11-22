package visual

import (
	"encoding/binary"
	"image"
	"sort"
)

// FNV-1a 64-bit constants.
const (
	fnvOffset64 = 14695981039346656037
	fnvPrime64  = 1099511628211
)

// hashRows returns an FNV-1a 64 hash of each row's first width pixels
// (RGBA bytes). Hashing only the overlapping width lets two screenshots of
// different widths still align on their shared columns.
//
// The hash folds in eight bytes (two pixels) per multiply instead of one:
// byte-wise FNV spent over 80 % of a full-page comparison hashing. Only
// equality of row hashes matters here, so the values need not match a
// byte-wise FNV implementation.
func hashRows(img *image.NRGBA, width int) []uint64 {
	b := img.Bounds()
	out := make([]uint64, b.Dy())
	n := width * 4
	for y := range out {
		off := img.PixOffset(b.Min.X, b.Min.Y+y)
		row := img.Pix[off : off+n]
		h := uint64(fnvOffset64)
		for len(row) >= 8 {
			h ^= binary.LittleEndian.Uint64(row)
			h *= fnvPrime64
			row = row[8:]
		}
		for _, c := range row {
			h ^= uint64(c)
			h *= fnvPrime64
		}
		out[y] = h
	}
	return out
}

// run is a stretch of rows equal on both sides: before rows [a, a+n) are the
// after rows [b, b+n).
type run struct{ a, b, n int }

// dy is the vertical offset of the run, after minus before.
func (r run) dy() int { return r.b - r.a }

// alignRows matches the rows of two images by their hashes and returns the
// matched runs in increasing order on both sides.
//
// It is a patience diff on rows: the common prefix and suffix are matched
// first, then rows whose hash is unique on both sides of the middle become
// anchors, the longest increasing subsequence of the anchors is kept, and
// every kept anchor is extended up and down through rows that are equal at the
// same offset. Extension is what lets repeated rows (blank gutters, flat
// backgrounds) align even though they can never be anchors themselves.
func alignRows(ha, hb []uint64) []run {
	la, lb := len(ha), len(hb)
	matchA := make([]int32, la)
	matchB := make([]int32, lb)
	for i := range matchA {
		matchA[i] = -1
	}
	for j := range matchB {
		matchB[j] = -1
	}
	pair := func(i, j int) {
		matchA[i] = int32(j)
		matchB[j] = int32(i)
	}

	prefix := 0
	for prefix < la && prefix < lb && ha[prefix] == hb[prefix] {
		pair(prefix, prefix)
		prefix++
	}
	suffix := 0
	for suffix < la-prefix && suffix < lb-prefix && ha[la-1-suffix] == hb[lb-1-suffix] {
		pair(la-1-suffix, lb-1-suffix)
		suffix++
	}

	kept := longestIncreasing(uniqueAnchors(ha[prefix:la-suffix], hb[prefix:lb-suffix], prefix))
	for _, an := range kept {
		pair(an.a, an.b)
	}
	for _, an := range kept {
		for i, j := an.a+1, an.b+1; i < la && j < lb && matchA[i] < 0 && matchB[j] < 0 && ha[i] == hb[j]; i, j = i+1, j+1 {
			pair(i, j)
		}
		for i, j := an.a-1, an.b-1; i >= 0 && j >= 0 && matchA[i] < 0 && matchB[j] < 0 && ha[i] == hb[j]; i, j = i-1, j-1 {
			pair(i, j)
		}
	}

	runs := collectRuns(matchA)

	// A short run whose offset disagrees with the long runs on both sides,
	// when those agree with each other, is a coincidental match: two rows
	// that happen to be unique and equal (a stripe of a repeated section, a
	// line of text reused at another offset). Kept, it would split one shift
	// into a removed band and an inserted band. Unmatch it and let the long
	// runs extend through the rows it held.
	if dropIslands(runs, matchA, matchB) {
		for _, r := range collectRuns(matchA) {
			if r.n < minIslandRows {
				continue
			}
			for i, j := r.a+r.n, r.b+r.n; i < la && j < lb && matchA[i] < 0 && matchB[j] < 0 && ha[i] == hb[j]; i, j = i+1, j+1 {
				pair(i, j)
			}
			for i, j := r.a-1, r.b-1; i >= 0 && j >= 0 && matchA[i] < 0 && matchB[j] < 0 && ha[i] == hb[j]; i, j = i-1, j-1 {
				pair(i, j)
			}
		}
		runs = collectRuns(matchA)
	}
	return runs
}

// minIslandRows is the length below which a run that disagrees with its
// neighbours is treated as a coincidental match. It is sized for fixed-position
// widgets (chat bubbles, badges, cookie buttons), which are commonly 40–60 px
// tall, while real matched content runs are hundreds of rows long.
const minIslandRows = 64

func collectRuns(matchA []int32) []run {
	var runs []run
	for i := range matchA {
		j := int(matchA[i])
		if j < 0 {
			continue
		}
		if k := len(runs) - 1; k >= 0 && runs[k].a+runs[k].n == i && runs[k].b+runs[k].n == j {
			runs[k].n++
			continue
		}
		runs = append(runs, run{a: i, b: j, n: 1})
	}
	return runs
}

// dropIslands unmatches short runs sandwiched between long runs that share an
// offset different from theirs. It reports whether anything was dropped.
func dropIslands(runs []run, matchA, matchB []int32) bool {
	dropped := false
	for i := 0; i < len(runs); i++ {
		if runs[i].n >= minIslandRows {
			continue
		}
		// The group of consecutive short runs starting at i.
		j := i
		for j < len(runs) && runs[j].n < minIslandRows {
			j++
		}
		if i == 0 || j == len(runs) {
			i = j
			continue
		}
		before, after := runs[i-1], runs[j]
		if before.dy() != after.dy() {
			i = j
			continue
		}
		for _, r := range runs[i:j] {
			if r.dy() == before.dy() {
				continue
			}
			for k := 0; k < r.n; k++ {
				matchB[r.b+k] = -1
				matchA[r.a+k] = -1
			}
			dropped = true
		}
		i = j
	}
	return dropped
}

// anchor is a row pair whose hash occurs exactly once on each side.
type anchor struct{ a, b int }

// uniqueAnchors returns the rows unique on both sides, ordered by before row.
// base is added to the returned indexes.
func uniqueAnchors(ha, hb []uint64, base int) []anchor {
	type seen struct{ ca, cb, ia, ib int }
	counts := make(map[uint64]*seen, len(ha))
	for i, h := range ha {
		s := counts[h]
		if s == nil {
			s = &seen{}
			counts[h] = s
		}
		s.ca++
		s.ia = i
	}
	for j, h := range hb {
		if s := counts[h]; s != nil {
			s.cb++
			s.ib = j
		}
	}
	var out []anchor
	for i, h := range ha {
		if s := counts[h]; s.ca == 1 && s.cb == 1 {
			out = append(out, anchor{a: base + i, b: base + s.ib})
		}
	}
	return out
}

// longestIncreasing returns the longest subsequence of anchors (already sorted
// by a) whose b is strictly increasing, by patience sorting.
func longestIncreasing(anchors []anchor) []anchor {
	if len(anchors) == 0 {
		return nil
	}
	tails := make([]int, 0, len(anchors)) // index into anchors of each pile top
	prev := make([]int, len(anchors))
	for i, an := range anchors {
		k := sort.Search(len(tails), func(t int) bool { return anchors[tails[t]].b >= an.b })
		if k > 0 {
			prev[i] = tails[k-1]
		} else {
			prev[i] = -1
		}
		if k == len(tails) {
			tails = append(tails, i)
		} else {
			tails[k] = i
		}
	}
	out := make([]anchor, len(tails))
	for i, k := len(tails)-1, tails[len(tails)-1]; i >= 0; i, k = i-1, prev[k] {
		out[i] = anchors[k]
	}
	return out
}

// gap is the stretch between two matched runs: before rows [a0, a1) and
// after rows [b0, b1), either of which may be empty.
type gap struct{ a0, a1, b0, b1 int }

// gaps returns the unmatched stretches between the runs, top to bottom.
func gaps(runs []run, la, lb int) []gap {
	var out []gap
	a, b := 0, 0
	for _, r := range runs {
		if r.a > a || r.b > b {
			out = append(out, gap{a0: a, a1: r.a, b0: b, b1: r.b})
		}
		a, b = r.a+r.n, r.b+r.n
	}
	if a < la || b < lb {
		out = append(out, gap{a0: a, a1: la, b0: b, b1: lb})
	}
	return out
}

// dominantShift returns the non-zero offset that explains at least minRows
// rows, and the first after row where it applies. ok is false when no
// offset qualifies.
func dominantShift(runs []run, minRows int) (fromY, dy int, ok bool) {
	rows := map[int]int{}
	first := map[int]int{}
	for _, r := range runs {
		d := r.dy()
		if _, seen := first[d]; !seen {
			first[d] = r.b
		}
		rows[d] += r.n
	}
	best, bestRows := 0, 0
	for d, n := range rows {
		if d != 0 && (n > bestRows || (n == bestRows && abs(d) < abs(best))) {
			best, bestRows = d, n
		}
	}
	if bestRows == 0 || bestRows < minRows {
		return 0, 0, false
	}
	return first[best], best, true
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
