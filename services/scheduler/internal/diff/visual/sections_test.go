package visual

import (
	"image"
	"math/rand/v2"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/capture"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/diff"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/geom"
)

// chartRect is where the test pages carry their "chart": an image-like area
// that a Watch Plan would watch as visual.
var chartRect = geom.Rect{500, 1200, 400, 240}

// drawChart fills rect with a picture that depends on seed.
func drawChart(img *image.NRGBA, rect geom.Rect, seed uint64) {
	fillColor(img, rect.Image(), sidebarC)
	rng := rand.New(rand.NewPCG(seed, 11))
	for x := rect.X() + 10; x+30 <= rect.X()+rect.W(); x += 40 {
		h := 30 + rng.IntN(rect.H()-50)
		fillColor(img, image.Rect(x, rect.Y()+rect.H()-10-h, x+24, rect.Y()+rect.H()-10), blue)
	}
}

// chartPage is the base page with a chart of the given seed, and the blocks
// of the page plus one for the chart.
func chartPage(seed uint64) (*image.NRGBA, []capture.Block) {
	img, blocks := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	drawChart(img, chartRect, seed)
	return img, append(blocks, capture.Block{ID: "chart", Tag: "img", Rect: chartRect})
}

func down(r geom.Rect, dy int) geom.Rect { return geom.Rect{r.X(), r.Y() + dy, r.W(), r.H()} }

func chartSection(a, b geom.Rect) []Section {
	return []Section{{ID: "chart", A: a, B: b, Compare: true}}
}

func TestSectionCropFindsAChangeBelowInsertedContent(t *testing.T) {
	a, blocksA := chartPage(1)
	b, _ := chartPage(2)
	// Unrelated content appears above the chart and pushes it down.
	b = insertRows(b, banner(pageW, 48), 100)
	after := down(chartRect, 48)
	blocksB := []capture.Block{{ID: "chart", Tag: "img", Rect: after}}

	ev := CompareSections(roundTrip(t, a), roundTrip(t, b), SectionOptions{
		Options:  Options{BlocksA: blocksA, BlocksB: blocksB},
		Sections: chartSection(chartRect, after),
	})
	require.NotEmpty(t, ev.Regions)
	for _, r := range ev.Regions {
		require.Equal(t, "chart", r.Section)
		require.Equal(t, diff.RegionChanged, r.Kind)
		require.True(t, r.Box.Image().In(after.Image()), "box %v is on the after screenshot, inside the Section", r.Box)
		require.NotNil(t, r.FromBox)
		require.True(t, r.FromBox.Image().In(chartRect.Image()), "from box %v is where the Section was before", *r.FromBox)
		require.Equal(t, r.Box, down(*r.FromBox, 48))
		require.Equal(t, []string{"chart"}, r.Blocks)
	}
	// The banner is outside the Section and the rest was not compared.
	require.Nil(t, ev.Shift)
	require.Equal(t, chartRect.Area(), ev.UnmaskedPixels, "only the Section was compared")
	require.Equal(t, [2]int{pageW, pageH}, ev.SizeBefore)
	require.Equal(t, [2]int{pageW, pageH + 48}, ev.SizeAfter)
}

func TestSectionCropIgnoresChangesAroundTheSection(t *testing.T) {
	a, _ := chartPage(1)
	b, _ := chartPage(1)
	// A banner above, and a button below that changed colour.
	recolor(b, buttonRect(3).Image(), blue, green)
	b = insertRows(b, banner(pageW, 48), 100)

	ev := CompareSections(a, b, SectionOptions{Sections: chartSection(chartRect, down(chartRect, 48))})
	requireNoChange(t, ev)
}

func TestSectionRestPass(t *testing.T) {
	a, _ := chartPage(1)
	b, _ := chartPage(2)
	br := buttonRect(3)
	recolor(b, br.Image(), blue, green)

	// The chart is a Section that is not watched for looks: its change is
	// left out, and the button outside it is found by the rest pass.
	sections := []Section{{ID: "chart", A: chartRect, B: chartRect}}
	ev := CompareSections(a, b, SectionOptions{Sections: sections, Rest: true})
	require.Len(t, ev.Regions, 1)
	require.Empty(t, ev.Regions[0].Section, "a rest region is outside every Section")
	require.True(t, ev.Regions[0].Box.Image().Overlaps(br.Image()))
	require.Equal(t, pageW*pageH-chartRect.Area(), ev.UnmaskedPixels)

	// Without the rest pass nothing is compared at all.
	requireNoChange(t, CompareSections(a, b, SectionOptions{Sections: sections}))

	// Watched for looks, the chart is found too, tagged with its Section.
	sections[0].Compare = true
	ev = CompareSections(a, b, SectionOptions{Sections: sections, Rest: true})
	bySection := map[string]int{}
	for _, r := range ev.Regions {
		bySection[r.Section]++
	}
	require.Positive(t, bySection["chart"])
	require.Equal(t, 1, bySection[""])
	require.Equal(t, "chart", ev.Regions[0].Section, "Sections come before the rest")
}

func TestSectionRestPassLeavesAGrownSectionToItself(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	// A full-width Section at row 100 is 48 rows tall before and 96 after.
	before := insertRows(a, banner(pageW, 48), 100)
	after := insertRows(a, banner(pageW, 96), 100)
	sections := []Section{{ID: "promo", A: geom.Rect{0, 100, pageW, 48}, B: geom.Rect{0, 100, pageW, 96}}}

	ev := CompareSections(before, after, SectionOptions{Sections: sections, Rest: true})
	require.Empty(t, ev.Regions, "the extra rows belong to the Section, which is not watched for looks")
	require.Zero(t, ev.ChangedPixels)
}

func TestSectionOnOneSideOnly(t *testing.T) {
	a, blocksA := chartPage(1)
	without, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	opts := Options{BlocksA: blocksA, BlocksB: blocksA}

	gone := CompareSections(a, without, SectionOptions{Options: opts, Sections: chartSection(chartRect, geom.Rect{})})
	require.Len(t, gone.Regions, 1)
	require.Equal(t, diff.RegionRemovedBand, gone.Regions[0].Kind)
	require.Equal(t, chartRect, gone.Regions[0].Box)
	require.Equal(t, &chartRect, gone.Regions[0].FromBox)
	require.Equal(t, "chart", gone.Regions[0].Section)
	require.Nil(t, gone.Regions[0].RectAfter())

	added := CompareSections(without, a, SectionOptions{Options: opts, Sections: chartSection(geom.Rect{}, chartRect)})
	require.Len(t, added.Regions, 1)
	require.Equal(t, diff.RegionInsertedBand, added.Regions[0].Kind)
	require.Equal(t, chartRect, added.Regions[0].Box)
	require.Nil(t, added.Regions[0].FromBox)
	require.Equal(t, chartRect.Area(), added.Regions[0].Pixels)

	// On neither side: nothing to say.
	requireNoChange(t, CompareSections(without, without, SectionOptions{Sections: chartSection(geom.Rect{}, geom.Rect{})}))
}

func TestSectionNestedSectionIsMaskedOutOfItsParent(t *testing.T) {
	a, _ := chartPage(1)
	b, _ := chartPage(2)
	outer := geom.Rect{0, 1000, pageW, 700}
	sections := []Section{
		{ID: "main", A: outer, B: outer, Compare: true},
		{ID: "chart", A: chartRect, B: chartRect}, // inside main, not watched for looks
	}
	requireNoChange(t, CompareSections(a, b, SectionOptions{Sections: sections}))

	sections[1].Compare = true
	ev := CompareSections(a, b, SectionOptions{Sections: sections})
	require.NotEmpty(t, ev.Regions)
	for _, r := range ev.Regions {
		require.Equal(t, "chart", r.Section, "the change is reported once, by the inner Section")
	}
}

func TestSectionMasksAreTranslatedIntoTheCrop(t *testing.T) {
	a, _ := chartPage(1)
	b, _ := chartPage(2)
	b = insertRows(b, banner(pageW, 48), 100)
	after := down(chartRect, 48)

	// Each Capture reports the chart as animating, at its own position.
	ev := CompareSections(a, b, SectionOptions{
		Options:  Options{MasksA: []geom.Rect{chartRect}, MasksB: []geom.Rect{after}},
		Sections: chartSection(chartRect, after),
	})
	requireNoChange(t, ev)
	require.Zero(t, ev.UnmaskedPixels)
}

func TestCompareChangedRegionCarriesItsBeforeBox(t *testing.T) {
	a, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	b, _ := drawPage(pageSpec{W: pageW, H: pageH, Seed: 1})
	br := buttonRect(2)
	recolor(b, br.Image(), blue, green)
	b = insertRows(b, banner(pageW, 48), 100)

	ev := Compare(a, b, Options{})
	require.Len(t, ev.Regions, 2)
	require.Nil(t, ev.Regions[0].FromBox, "an inserted band has no before side")
	require.Nil(t, ev.Regions[0].RectBefore())
	changed := ev.Regions[1]
	require.Equal(t, changed.Box, down(*changed.FromBox, 48), "the before box is 48 rows higher")
	require.True(t, changed.FromBox.Image().Overlaps(br.Image()))
}
