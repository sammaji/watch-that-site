package text

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
	"github.com/stretchr/testify/require"
)

func p(id, text string) diff.NBlock { return block(id, "p", text, false) }

func opKinds(ev *diff.TextEvidence) []diff.OpKind {
	out := make([]diff.OpKind, len(ev.Ops))
	for i, op := range ev.Ops {
		out[i] = op.Op
	}
	return out
}

// lcsLen is the textbook O(nm) LCS length, the reference for Myers.
func lcsLen(a, b []int) int {
	dp := make([][]int, len(a)+1)
	for i := range dp {
		dp[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else {
				dp[i][j] = max(dp[i+1][j], dp[i][j+1])
			}
		}
	}
	return dp[0][0]
}

func requireValidMatches(t *testing.T, a, b []int, ms []match) {
	t.Helper()
	for k, m := range ms {
		require.Equal(t, a[m.I], b[m.J], "match %d is not equal", k)
		if k > 0 {
			require.Greater(t, m.I, ms[k-1].I)
			require.Greater(t, m.J, ms[k-1].J)
		}
	}
}

func TestMyersIsOptimal(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for iter := 0; iter < 500; iter++ {
		a := make([]int, rng.Intn(30))
		b := make([]int, rng.Intn(30))
		for i := range a {
			a[i] = rng.Intn(5)
		}
		for i := range b {
			b[i] = rng.Intn(5)
		}
		ms := myers(a, b)
		requireValidMatches(t, a, b, ms)
		require.Equal(t, lcsLen(a, b), len(ms), "a=%v b=%v", a, b)
	}
}

func TestMyersEdges(t *testing.T) {
	require.Empty(t, myers(nil, []int{1}))
	require.Empty(t, myers([]int{1}, nil))
	require.Equal(t, []match{{0, 0}, {1, 1}}, myers([]int{1, 2}, []int{1, 2}))
	require.Equal(t, []match{{0, 1}}, myers([]int{7}, []int{3, 7, 4}))
}

func TestMyersGivesUpBeyondMaxD(t *testing.T) {
	n := maxMyersD
	a, b := make([]int, n), make([]int, n)
	for i := range a {
		a[i], b[i] = i, n+i
	}
	a[n/2], b[n/2] = -1, -1 // one shared value, but D = 2n-2 > maxMyersD
	require.Empty(t, myers(a, b))
}

func TestLIS(t *testing.T) {
	require.Nil(t, lis(nil))
	require.Equal(t, []int{0}, lis([]int{5}))
	require.Equal(t, []int{0, 1, 2}, lis([]int{1, 2, 3}))
	seq := []int{3, 1, 4, 1, 5, 9, 2, 6}
	idx := lis(seq)
	require.Len(t, idx, 4) // e.g. 1 4 5 9 / 3 4 5 6
	for k := 1; k < len(idx); k++ {
		require.Greater(t, idx[k], idx[k-1])
		require.Greater(t, seq[idx[k]], seq[idx[k-1]])
	}
}

func TestAlignRandomIsValidAndOptimalWithoutAnchors(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for iter := 0; iter < 300; iter++ {
		a := make([]int, rng.Intn(40))
		b := make([]int, rng.Intn(40))
		for i := range a {
			a[i] = rng.Intn(20)
		}
		for i := range b {
			b[i] = rng.Intn(20)
		}
		ms := align(a, b, 20)
		requireValidMatches(t, a, b, ms)
		require.LessOrEqual(t, len(ms), lcsLen(a, b))
	}
}

func TestJaccard(t *testing.T) {
	require.InDelta(t, 0.0, jaccard(nil, nil), 1e-9)
	require.InDelta(t, 1.0, jaccard([]int{1, 2}, []int{1, 2}), 1e-9)
	require.InDelta(t, 0.5, jaccard([]int{1, 2, 3}, []int{2, 3, 4}), 1e-9)
	require.InDelta(t, 0.0, jaccard([]int{1}, []int{2}), 1e-9)
}

func TestPairGapBestScoreFirstAndSameTag(t *testing.T) {
	a := []diff.NBlock{
		p("a0", "alpha beta gamma delta"),
		p("a1", "one two three four"),
		block("a2", "h2", "red green blue", false),
	}
	b := []diff.NBlock{
		p("b0", "one two three five"),       // 3/5 with a1
		p("b1", "alpha beta gamma epsilon"), // 3/5 with a0
		p("b2", "red green blue"),           // same words as a2, but a p
		p("b3", "unrelated words here"),
	}
	pairs := pairGap(a, b, []int{0, 1, 2}, []int{0, 1, 2, 3}, newWordSets())
	require.ElementsMatch(t, [][2]int{{0, 1}, {1, 0}}, pairs)
}

func TestPairGapOneToOneAlwaysPairsSameTag(t *testing.T) {
	a := []diff.NBlock{p("a", "completely different")}
	b := []diff.NBlock{p("b", "nothing shared at all")}
	require.Equal(t, [][2]int{{0, 0}}, pairGap(a, b, []int{0}, []int{0}, newWordSets()))

	b[0].Tag = "li"
	require.Empty(t, pairGap(a, b, []int{0}, []int{0}, newWordSets()))
}

func TestModifyVersusRemoveAdd(t *testing.T) {
	a := []diff.NBlock{p("h", "Header"), p("x", "In stock and ready to ship today"), p("y", "Old promo banner text here"), p("f", "Footer")}
	b := []diff.NBlock{p("h", "Header"), p("x", "In stock and ready to ship tomorrow"), p("z", "Brand new unrelated notice"), p("f", "Footer")}
	ev := Compare(a, b)
	require.Equal(t, []diff.OpKind{diff.OpModify, diff.OpRemove, diff.OpAdd}, opKinds(ev))
	require.Equal(t, "x", ev.Ops[0].BlockID)
	require.Equal(t, "y", ev.Ops[1].FromBlockID)
	require.Equal(t, "z", ev.Ops[2].BlockID)
	require.Equal(t, 3, ev.Magnitude.BlocksChanged)
	require.Equal(t, 1+4, ev.Magnitude.WordsAdded)   // tomorrow + 4 new words
	require.Equal(t, 1+5, ev.Magnitude.WordsRemoved) // today + 5 old words
}

func TestIdenticalInputs(t *testing.T) {
	a := []diff.NBlock{p("1", "Hello"), p("2", "World")}
	ev := Compare(a, a)
	require.NotNil(t, ev.Ops)
	require.Empty(t, ev.Ops)
	require.Equal(t, diff.TextMagnitude{}, ev.Magnitude)

	ev = Compare(nil, nil)
	require.NotNil(t, ev.Ops)
	require.Empty(t, ev.Ops)
}

func TestEmptySides(t *testing.T) {
	blocks := []diff.NBlock{p("1", "Hello there"), p("2", "World")}
	ev := Compare(nil, blocks)
	require.Equal(t, []diff.OpKind{diff.OpAdd, diff.OpAdd}, opKinds(ev))
	require.Equal(t, 3, ev.Magnitude.WordsAdded)
	require.InDelta(t, 1.0, ev.Magnitude.ChangeRatio, 1e-9)
	require.Equal(t, 2, ev.Magnitude.NetAdded)

	ev = Compare(blocks, nil)
	require.Equal(t, []diff.OpKind{diff.OpRemove, diff.OpRemove}, opKinds(ev))
	require.Equal(t, 2, ev.Magnitude.NetRemoved)
}

func TestContext(t *testing.T) {
	a := []diff.NBlock{p("1", "one"), p("2", "two"), p("3", "three"), p("ig", "ignored"), p("4", "four"), p("5", "five"), p("6", "six")}
	a[3].Ignored = true
	b := append([]diff.NBlock{}, a...)
	b[4] = p("4", "four changed words") // 1:1 gap → modify
	ev := Compare(a, b)
	require.Len(t, ev.Ops, 1)
	// The ignored neighbour is skipped.
	require.Equal(t, []string{"two", "three"}, ev.Ops[0].ContextBefore)
	require.Equal(t, []string{"five", "six"}, ev.Ops[0].ContextAfter)

	// A remove sits between its neighbours.
	b = []diff.NBlock{a[0], a[1], a[3], a[4], a[5], a[6]} // "three" removed
	ev = Compare(a, b)
	require.Len(t, ev.Ops, 1)
	require.Equal(t, diff.OpRemove, ev.Ops[0].Op)
	require.Equal(t, []string{"one", "two"}, ev.Ops[0].ContextBefore)
	require.Equal(t, []string{"four", "five"}, ev.Ops[0].ContextAfter)

	// At the document edges context is short.
	ev = Compare(a[1:], a)
	require.Len(t, ev.Ops, 1)
	require.Empty(t, ev.Ops[0].ContextBefore)
	require.Equal(t, []string{"two", "three"}, ev.Ops[0].ContextAfter)
}

func TestMagnitudes(t *testing.T) {
	a := []diff.NBlock{p("1", "alpha beta gamma delta"), p("2", "keep this"), p("3", "gone block")}
	b := []diff.NBlock{p("1", "alpha beta gamma epsilon"), p("2", "keep this"), p("4", "new one here"), p("5", "keep this")}
	ev := Compare(a, b)
	m := ev.Magnitude
	require.Equal(t, 1+3+2, m.WordsAdded) // epsilon + "new one here" + duplicate "keep this"
	require.Equal(t, 1+2, m.WordsRemoved) // delta + "gone block"
	require.Equal(t, 4, m.BlocksChanged)  // modify, remove, add, add
	// before 8 words, after 11 words.
	require.InDelta(t, 9.0/11.0, m.ChangeRatio, 1e-9)
	// Multisets: before {1,keep,gone}, after {1',keep,keep,new}.
	require.Equal(t, 3, m.NetAdded)
	require.Equal(t, 2, m.NetRemoved)
}

func TestMaskedTokensDoNotCount(t *testing.T) {
	a := []diff.NBlock{block("1", "p", "Price $10 seen {{reltime:3 minutes ago}}", false)}
	b := []diff.NBlock{block("1", "p", "Price $12 seen {{reltime:5 minutes ago}}", false)}
	ev := Compare(a, b)
	require.Len(t, ev.Ops, 1)
	op := ev.Ops[0]
	require.Equal(t, diff.OpModify, op.Op)
	require.Equal(t, []string{"reltime"}, op.Masked)
	require.Equal(t, []string{"reltime"}, ev.Masked)
	require.Equal(t, 1, ev.Magnitude.WordsAdded)
	require.Equal(t, 1, ev.Magnitude.WordsRemoved)
	last := op.Tokens[len(op.Tokens)-1]
	require.Equal(t, diff.WordOp{Op: "=", Text: "5 minutes ago", Mask: "reltime"}, last)
}

func TestIgnoredStatusFlip(t *testing.T) {
	a := []diff.NBlock{p("h", "Head"), p("x", "Some banner"), p("f", "Foot")}
	b := []diff.NBlock{p("h", "Head"), p("x", "Some banner"), p("f", "Foot")}
	b[1].Ignored = true
	ev := Compare(a, b)
	require.Equal(t, []diff.OpKind{diff.OpIgnored}, opKinds(ev))
	require.Empty(t, ev.CountedOps())
	require.Equal(t, 1, ev.IgnoredCount)
	require.Equal(t, "Some banner", ev.Ops[0].Text)
	require.Equal(t, "Some banner", ev.Ops[0].OldText)
}

func TestIgnoredAddRemoveNeverCount(t *testing.T) {
	a := []diff.NBlock{p("h", "Head"), block("ad", "div", "Ad one two three", true), p("f", "Foot")}
	b := []diff.NBlock{p("h", "Head"), p("f", "Foot"), block("ad2", "aside", "Other ad", true)}
	ev := Compare(a, b)
	require.Equal(t, []diff.OpKind{diff.OpIgnored, diff.OpIgnored}, opKinds(ev))
	require.Equal(t, 2, ev.IgnoredCount)
	require.Equal(t, diff.TextMagnitude{}, ev.Magnitude)
}

func TestMovesAndEditsCombined(t *testing.T) {
	a := []diff.NBlock{
		p("t", "Changelog"), p("5", "Legacy exporter"), p("1", "Faster sync engine"),
		p("2", "Dark mode for the dashboard"), p("3", "Pricing starts at $49 per seat"), p("4", "Bug fixes"),
	}
	b := []diff.NBlock{
		p("t", "Changelog"), p("2", "Dark mode for the dashboard"), p("3", "Pricing starts at $59 per seat"),
		p("4", "Bug fixes"), p("1", "Faster sync engine"), p("6", "SAML single sign-on"),
	}
	ev := Compare(a, b)
	require.Equal(t, []diff.OpKind{diff.OpRemove, diff.OpModify, diff.OpMove, diff.OpAdd}, opKinds(ev))
	require.Equal(t, "5", ev.Ops[0].FromBlockID)
	require.Equal(t, []string{"Changelog"}, ev.Ops[0].ContextBefore)
	require.Equal(t, "3", ev.Ops[1].BlockID)
	mv := ev.Ops[2]
	require.Equal(t, "1", mv.BlockID)
	require.Equal(t, 2, mv.From)
	require.Equal(t, 4, mv.To)
	require.Equal(t, "6", ev.Ops[3].BlockID)
	require.Equal(t, 1, ev.Magnitude.Moves)
	require.Equal(t, 3, ev.Magnitude.BlocksChanged)
	require.Equal(t, 2, ev.Magnitude.NetAdded)
	require.Equal(t, 2, ev.Magnitude.NetRemoved)
}

func TestOneToOneGapIsRewrite(t *testing.T) {
	a := []diff.NBlock{p("t", "Changelog"), p("5", "Legacy exporter")}
	b := []diff.NBlock{p("t", "Changelog"), p("6", "SAML single sign-on")}
	ev := Compare(a, b)
	require.Equal(t, []diff.OpKind{diff.OpModify}, opKinds(ev))
	require.True(t, ev.Ops[0].Whole)
}

func TestDuplicatesDoNotScrambleAlignment(t *testing.T) {
	var a []diff.NBlock
	for i := 0; i < 50; i++ {
		a = append(a, block(fmt.Sprintf("n%d", i), "h3", fmt.Sprintf("Item %d", i), false))
		a = append(a, block(fmt.Sprintf("c%d", i), "button", "Add to cart", false))
		a = append(a, block(fmt.Sprintf("s%d", i), "span", "Free returns", false))
	}
	b := append([]diff.NBlock{}, a...)
	// Change one product name and one boilerplate label in the middle.
	b[30] = block("n10", "h3", "Item ten", false)
	b[61] = block("c20", "button", "Sold out", false)
	ev := Compare(a, b)
	require.Equal(t, []diff.OpKind{diff.OpModify, diff.OpModify}, opKinds(ev))
	require.Equal(t, "n10", ev.Ops[0].BlockID)
	require.Equal(t, "c20", ev.Ops[1].BlockID)
	require.Equal(t, 0, ev.Magnitude.Moves)

	// Only boilerplate, one extra copy in the middle: one add, nothing else.
	var c []diff.NBlock
	for i := 0; i < 100; i++ {
		c = append(c, block(fmt.Sprintf("c%d", i), "button", "Add to cart", false))
	}
	d := append(append(append([]diff.NBlock{}, c[:50]...), block("x", "button", "Add to cart", false)), c[50:]...)
	ev = Compare(c, d)
	require.Equal(t, []diff.OpKind{diff.OpAdd}, opKinds(ev))
	require.Equal(t, 0, ev.Magnitude.NetRemoved)
	require.Equal(t, 1, ev.Magnitude.NetAdded)
}

func TestOpsCarryIdentity(t *testing.T) {
	a := []diff.NBlock{p("old", "Pro plan $49/month")}
	b := []diff.NBlock{p("new", "Pro plan $59/month")}
	a[0].Rect = geom.Rect{0, 10, 100, 20}
	b[0].Rect = geom.Rect{0, 12, 100, 20}
	ev := Compare(a, b)
	require.Len(t, ev.Ops, 1)
	op := ev.Ops[0]
	require.Equal(t, "new", op.BlockID)
	require.Equal(t, "old", op.FromBlockID)
	require.Equal(t, "p", op.Tag)
	require.Equal(t, b[0].Path, op.Path)
	require.Equal(t, &b[0].Rect, op.Rect)
	require.Equal(t, &a[0].Rect, op.FromRect)
	require.Equal(t, "$59", op.AddedText())
	require.Equal(t, "$49", op.RemovedText())
}

func TestTokenIndexToRuneSkipsSurrogates(t *testing.T) {
	require.Equal(t, rune(0xD7FF), tokenIndexToRune(0xD7FF))
	require.Equal(t, rune(0xE000), tokenIndexToRune(0xD800))

	// More distinct tokens than the surrogate boundary still diff exactly.
	var ta, tb []diff.Token
	for i := 0; i < 0xD800+50; i++ {
		w := fmt.Sprintf("w%d", i)
		tok := diff.Token{Display: w, Compare: w, Kind: diff.TokenWord}
		ta = append(ta, tok)
		if i == 0xD800+10 {
			tok = diff.Token{Display: "changed", Compare: "changed", Kind: diff.TokenWord}
		}
		tb = append(tb, tok)
	}
	wd := diffTokens(ta, tb, "", "")
	require.False(t, wd.Whole)
	require.Equal(t, 1, wd.Added)
	require.Equal(t, 1, wd.Removed)
}

// randomPage builds n unique paragraphs from a small vocabulary.
func randomPage(rng *rand.Rand, n int) []diff.NBlock {
	vocab := strings.Fields("the a pricing plan team pro enterprise seat month year support " +
		"priority sync export import dashboard report alert monitor change page site " +
		"free trial upgrade billing invoice account user admin api key webhook")
	out := make([]diff.NBlock, n)
	for i := range out {
		words := make([]string, 6+rng.Intn(10))
		for k := range words {
			words[k] = vocab[rng.Intn(len(vocab))]
		}
		out[i] = p(fmt.Sprintf("b%d", i), fmt.Sprintf("%s %d", strings.Join(words, " "), i))
	}
	return out
}

func editPage(rng *rand.Rand, a []diff.NBlock, edits int) []diff.NBlock {
	b := append([]diff.NBlock{}, a...)
	for e := 0; e < edits; e++ {
		k := rng.Intn(len(b))
		switch e % 3 {
		case 0:
			b[k] = p(b[k].ID, b[k].Display+" updated")
		case 1:
			b = append(b[:k], b[k+1:]...)
		default:
			ins := p(fmt.Sprintf("new%d", e), fmt.Sprintf("brand new paragraph number %d", e))
			b = append(b[:k], append([]diff.NBlock{ins}, b[k:]...)...)
		}
	}
	return b
}

func TestLargeRandomEdits(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	a := randomPage(rng, 5000)
	b := editPage(rng, a, 10)
	ev := Compare(a, b)
	require.NotEmpty(t, ev.Ops)
	require.LessOrEqual(t, len(ev.Ops), 10)
	require.Zero(t, ev.Magnitude.Moves)
}

func BenchmarkCompare5000Blocks10Edits(b *testing.B) {
	rng := rand.New(rand.NewSource(4))
	before := randomPage(rng, 5000)
	after := editPage(rng, before, 10)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Compare(before, after)
	}
}

// Semantic cleanup folds a short unchanged word into the edit for display,
// but magnitudes count the minimal diff: two inserted words are two words,
// not "team" removed and "growing team quickly" added.
func TestMagnitudesIgnoreSemanticCleanup(t *testing.T) {
	a := []diff.NBlock{block("1", "p", "Pick a plan that fits your team.", false)}
	b := []diff.NBlock{block("1", "p", "Pick a plan that fits your growing team quickly.", false)}
	ev := Compare(a, b)
	require.Equal(t, 2, ev.Magnitude.WordsAdded)
	require.Zero(t, ev.Magnitude.WordsRemoved)
}
