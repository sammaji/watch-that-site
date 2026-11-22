package text

import (
	"math"
	"sort"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
)

// pairThreshold is the minimum word Jaccard similarity for a leftover delete
// and insert to be paired as a modify.
const pairThreshold = 0.5

// pairWindow bounds the candidates considered in very large gaps: when a gap
// has more than maxFullPairs delete×insert combinations, each delete is only
// compared with inserts within pairWindow of its proportional position.
const (
	maxFullPairs = 40_000
	pairWindow   = 100
)

// wordSets interns counted-token Compare text into ids and caches each
// block's sorted unique id set for Jaccard similarity.
type wordSets struct {
	ids map[string]int
}

func newWordSets() *wordSets { return &wordSets{ids: map[string]int{}} }

// set returns the sorted unique ids of the block's counted tokens.
func (w *wordSets) set(blk diff.NBlock) []int {
	out := make([]int, 0, len(blk.Tokens))
	for _, t := range blk.Tokens {
		if !t.Counts() {
			continue
		}
		id, ok := w.ids[t.Compare]
		if !ok {
			id = len(w.ids)
			w.ids[t.Compare] = id
		}
		out = append(out, id)
	}
	sort.Ints(out)
	uniq := out[:0]
	for i, id := range out {
		if i == 0 || id != out[i-1] {
			uniq = append(uniq, id)
		}
	}
	return uniq
}

// jaccard is |a∩b| / |a∪b| over two sorted unique sets; 0 when both are empty.
func jaccard(a, b []int) float64 {
	if len(a) == 0 && len(b) == 0 {
		return 0
	}
	inter := 0
	for i, j := 0, 0; i < len(a) && j < len(b); {
		switch {
		case a[i] == b[j]:
			inter++
			i++
			j++
		case a[i] < b[j]:
			i++
		default:
			j++
		}
	}
	return float64(inter) / float64(len(a)+len(b)-inter)
}

// pairGap pairs leftover deletes (positions in a) with leftover inserts
// (positions in b) inside one gap. Candidates need the same tag and a word
// Jaccard ≥ pairThreshold; they are taken greedily, best score first, ties
// broken by how close the two blocks sit in the gap. A gap holding exactly
// one delete and one insert with the same tag is always paired: the block in
// that slot was rewritten, which renders as a (possibly whole-block) modify.
// It returns pairs as (delete index, insert index) into dels and ins.
func pairGap(a, b []diff.NBlock, dels, ins []int, ws *wordSets) [][2]int {
	if len(dels) == 0 || len(ins) == 0 {
		return nil
	}
	if len(dels) == 1 && len(ins) == 1 {
		if a[dels[0]].Tag == b[ins[0]].Tag {
			return [][2]int{{0, 0}}
		}
		return nil
	}

	type cand struct {
		p, q  int
		score float64
		dist  float64
	}
	setsA := make([][]int, len(dels))
	for p, i := range dels {
		setsA[p] = ws.set(a[i])
	}
	setsB := make([][]int, len(ins))
	for q, j := range ins {
		setsB[q] = ws.set(b[j])
	}

	nd, ni := len(dels), len(ins)
	full := nd*ni <= maxFullPairs
	var cands []cand
	for p := range dels {
		lo, hi := 0, ni
		if !full {
			c := p * ni / nd
			lo, hi = max(0, c-pairWindow), min(ni, c+pairWindow+1)
		}
		for q := lo; q < hi; q++ {
			if a[dels[p]].Tag != b[ins[q]].Tag {
				continue
			}
			s := jaccard(setsA[p], setsB[q])
			if s < pairThreshold {
				continue
			}
			rel := math.Abs(float64(p)/float64(nd) - float64(q)/float64(ni))
			cands = append(cands, cand{p, q, s, rel})
		}
	}
	sort.Slice(cands, func(x, y int) bool {
		cx, cy := cands[x], cands[y]
		if cx.score != cy.score {
			return cx.score > cy.score
		}
		if cx.dist != cy.dist {
			return cx.dist < cy.dist
		}
		if cx.p != cy.p {
			return cx.p < cy.p
		}
		return cx.q < cy.q
	})
	usedP := make([]bool, nd)
	usedQ := make([]bool, ni)
	var out [][2]int
	for _, c := range cands {
		if usedP[c.p] || usedQ[c.q] {
			continue
		}
		usedP[c.p], usedQ[c.q] = true, true
		out = append(out, [2]int{c.p, c.q})
	}
	return out
}
