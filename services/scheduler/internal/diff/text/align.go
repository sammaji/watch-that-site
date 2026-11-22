package text

import "sort"

// match is one aligned pair of block positions: a[I] and b[J] hash equal.
type match struct{ I, J int }

// maxMyersD bounds the edit distance the Myers fallback explores. A gap that
// needs more edits than this is treated as a full replacement (every block
// deleted and inserted), which keeps time and memory bounded on pages that
// were rewritten wholesale. The trace needs about maxMyersD² int32s.
const maxMyersD = 1024

// aligner runs patience anchoring over two sequences of block hash ids.
type aligner struct {
	a, b []int
	// Scratch space indexed by hash id, reset after every use.
	cntA, cntB []int32
	posB       []int
	out        []match
}

// align returns the matched positions of a and b in increasing order. Hash
// ids must be in [0, nIDs).
func align(a, b []int, nIDs int) []match {
	al := &aligner{
		a:    a,
		b:    b,
		cntA: make([]int32, nIDs),
		cntB: make([]int32, nIDs),
		posB: make([]int, nIDs),
	}
	al.patience(0, len(a), 0, len(b))
	return al.out
}

// patience aligns a[aLo:aHi] with b[bLo:bHi]: strip the common prefix and
// suffix, anchor on hashes unique in both ranges (keeping the longest
// increasing run of anchors), and recurse into the gaps. A range without
// unique anchors falls back to Myers.
func (al *aligner) patience(aLo, aHi, bLo, bHi int) {
	for aLo < aHi && bLo < bHi && al.a[aLo] == al.b[bLo] {
		al.out = append(al.out, match{aLo, bLo})
		aLo++
		bLo++
	}
	suffix := 0
	for aLo < aHi-suffix && bLo < bHi-suffix && al.a[aHi-1-suffix] == al.b[bHi-1-suffix] {
		suffix++
	}
	aEnd, bEnd := aHi-suffix, bHi-suffix
	defer func() {
		for k := 0; k < suffix; k++ {
			al.out = append(al.out, match{aEnd + k, bEnd + k})
		}
	}()
	if aLo == aEnd || bLo == bEnd {
		return
	}

	anchors := al.uniqueAnchors(aLo, aEnd, bLo, bEnd)
	if len(anchors) == 0 {
		for _, m := range myers(al.a[aLo:aEnd], al.b[bLo:bEnd]) {
			al.out = append(al.out, match{aLo + m.I, bLo + m.J})
		}
		return
	}

	js := make([]int, len(anchors))
	for k, m := range anchors {
		js[k] = m.J
	}
	pa, pb := aLo, bLo
	for _, k := range lis(js) {
		m := anchors[k]
		al.patience(pa, m.I, pb, m.J)
		al.out = append(al.out, m)
		pa, pb = m.I+1, m.J+1
	}
	al.patience(pa, aEnd, pb, bEnd)
}

// uniqueAnchors returns, in a order, the pairs whose hash occurs exactly once
// in a[aLo:aHi] and exactly once in b[bLo:bHi].
func (al *aligner) uniqueAnchors(aLo, aHi, bLo, bHi int) []match {
	for _, id := range al.a[aLo:aHi] {
		al.cntA[id]++
	}
	for j := bLo; j < bHi; j++ {
		id := al.b[j]
		al.cntB[id]++
		al.posB[id] = j
	}
	var anchors []match
	for i := aLo; i < aHi; i++ {
		id := al.a[i]
		if al.cntA[id] == 1 && al.cntB[id] == 1 {
			anchors = append(anchors, match{i, al.posB[id]})
		}
	}
	for _, id := range al.a[aLo:aHi] {
		al.cntA[id] = 0
	}
	for _, id := range al.b[bLo:bHi] {
		al.cntB[id] = 0
	}
	return anchors
}

// lis returns the indices of a longest strictly increasing subsequence of
// seq, in order (patience sorting with predecessor links, O(n log n)).
func lis(seq []int) []int {
	if len(seq) == 0 {
		return nil
	}
	// tails[k] is the index in seq of the smallest tail of an increasing
	// run of length k+1.
	tails := make([]int, 0, len(seq))
	prev := make([]int, len(seq))
	for i, v := range seq {
		k := sort.Search(len(tails), func(n int) bool { return seq[tails[n]] >= v })
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
	out := make([]int, len(tails))
	for k, i := len(tails)-1, tails[len(tails)-1]; k >= 0; k, i = k-1, prev[i] {
		out[k] = i
	}
	return out
}

// myers returns the matched positions of a shortest edit script between a
// and b (Myers 1986, greedy forward pass with a trace for backtracking). It
// returns no matches when the edit distance exceeds maxMyersD.
func myers(a, b []int) []match {
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return nil
	}
	maxD := n + m
	if maxD > maxMyersD {
		maxD = maxMyersD
	}
	off := maxD + 1
	v := make([]int32, 2*maxD+3)
	// trace[d] holds v[k] for k in [-d-1, d+1] as it was before round d.
	trace := make([][]int32, 0, 16)
	found := -1
	for d := 0; d <= maxD && found < 0; d++ {
		snap := make([]int32, 2*d+3)
		copy(snap, v[off-d-1:off+d+2])
		trace = append(trace, snap)
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = int(v[off+k+1])
			} else {
				x = int(v[off+k-1]) + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x++
				y++
			}
			v[off+k] = int32(x)
			if x >= n && y >= m {
				found = d
				break
			}
		}
	}
	if found < 0 {
		return nil
	}

	var out []match
	x, y := n, m
	for d := found; d >= 0; d-- {
		snap := trace[d]
		at := func(k int) int { return int(snap[k+d+1]) }
		k := x - y
		var prevK int
		if k == -d || (k != d && at(k-1) < at(k+1)) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := at(prevK)
		prevY := prevX - prevK
		if d == 0 {
			prevX, prevY = 0, 0
		}
		for x > prevX && y > prevY {
			x--
			y--
			out = append(out, match{x, y})
		}
		x, y = prevX, prevY
	}
	for l, r := 0, len(out)-1; l < r; l, r = l+1, r-1 {
		out[l], out[r] = out[r], out[l]
	}
	return out
}
