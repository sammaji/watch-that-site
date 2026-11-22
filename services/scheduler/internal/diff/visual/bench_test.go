package visual

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// BenchmarkCompareFullPage compares two 1366×8000 pages that differ by one
// button colour: the WP6 budget is 400 ms.
func BenchmarkCompareFullPage(b *testing.B) {
	before, blocks := drawPage(pageSpec{W: 1366, H: 8000, Seed: 1})
	after, _ := drawPage(pageSpec{W: 1366, H: 8000, Seed: 1})
	recolor(after, buttonRect(5).Image(), blue, green)
	opts := Options{BlocksA: blocks, BlocksB: blocks}

	ev := Compare(before, after, opts)
	require.Len(b, ev.Regions, 1)

	b.ReportAllocs()
	for b.Loop() {
		Compare(before, after, opts)
	}
}

// BenchmarkCompareFullPageShifted is the same page with a banner inserted
// near the top, so almost every row is shifted.
func BenchmarkCompareFullPageShifted(b *testing.B) {
	before, blocks := drawPage(pageSpec{W: 1366, H: 8000, Seed: 1})
	after, _ := drawPage(pageSpec{W: 1366, H: 8000, Seed: 1})
	recolor(after, buttonRect(5).Image(), blue, green)
	after = insertRows(after, banner(1366, 48), 100)
	opts := Options{BlocksA: blocks, BlocksB: blocks}

	ev := Compare(before, after, opts)
	require.Len(b, ev.Regions, 2)

	b.ReportAllocs()
	for b.Loop() {
		Compare(before, after, opts)
	}
}

// BenchmarkCompareUnrelatedPages is the worst case: two pages with nothing in
// common, so no row aligns and the whole page goes through the pixel diff,
// where imagediff's anti-aliasing detector dominates.
func BenchmarkCompareUnrelatedPages(b *testing.B) {
	before, _ := drawPage(pageSpec{W: 1366, H: 8000, Seed: 1})
	after, _ := drawPage(pageSpec{W: 1366, H: 8000, Seed: 2})

	b.ReportAllocs()
	for b.Loop() {
		Compare(before, after, Options{})
	}
}
