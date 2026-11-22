// Ported from mapbox/pixelmatch v7.2.0 (index.js), commit
// c6fee35afac3c52576b2cb424bd1061ab6a4bd06.
//
// Copyright (c) 2025, Mapbox — ISC License (see LICENSE-pixelmatch).
//
// This file mirrors the upstream color-difference code function for function and
// name for name so upstream changes can be applied mechanically. Prefer keeping
// it un-idiomatic over restructuring it.

package imagediff

import "math"

// sRGB [0..255] -> linear [0..1] lookup table (padded with a 257th entry for interpolation)
var lin [257]float64

// premultiplied LMS matrix contributions for opaque sRGB byte values
var (
	lR, lG, lB [256]float64
	mR, mG, mB [256]float64
	sR, sG, sB [256]float64
)

// cube root over [0..1] via lookup table with linear interpolation
const cbrtN = 4096

var cbrt [cbrtN + 2]float64

const (
	toeK1 = 0.206
	toeK2 = 0.03
	toeK3 = (1 + toeK1) / (1 + toeK2)
)

func init() {
	for i := 0; i < 256; i++ {
		c := float64(i) / 255
		if c <= 0.04045 {
			lin[i] = c / 12.92
		} else {
			lin[i] = math.Pow((c+0.055)/1.055, 2.4)
		}
	}
	lin[256] = lin[255]

	for i := 0; i < 256; i++ {
		lr := lin[i]
		lR[i] = 0.4122214708 * lr
		mR[i] = 0.2119034982 * lr
		sR[i] = 0.0883024619 * lr
		lG[i] = 0.5363325363 * lr
		mG[i] = 0.6806995451 * lr
		sG[i] = 0.2817188376 * lr
		lB[i] = 0.0514459929 * lr
		mB[i] = 0.1073969566 * lr
		sB[i] = 0.6299787005 * lr
	}

	for i := 0; i <= cbrtN+1; i++ {
		cbrt[i] = math.Cbrt(float64(i) / cbrtN)
	}
}

// linLUT is sRGB->linear for a fractional [0..255] channel value via linear
// interpolation of lin.
func linLUT(x float64) float64 {
	i := int(x)
	return lin[i] + (lin[i+1]-lin[i])*(x-float64(i))
}

func cbrtLUT(x float64) float64 {
	t := x * cbrtN
	i := int(t)
	return cbrt[i] + (cbrt[i+1]-cbrt[i])*(t-float64(i))
}

// direct-mapped cache for opaque RGB -> cube-rooted LMS values and toe-corrected
// OKLab lightness. Upstream uses module-level typed arrays; here it is owned by
// the caller (see cachePool) so parallel workers do not share one. The cache is
// pure — the value is a function of the key — so it can never change results.
const (
	oklabCacheBits  = 12
	oklabCacheShift = 32 - oklabCacheBits
	oklabCacheSize  = 1 << oklabCacheBits
)

type oklabCache struct {
	keys   [oklabCacheSize]uint32
	values [oklabCacheSize * 4]float64
}

// colorDelta calculates the perceptual color difference between two pixels using
// the OKLab color space (Björn Ottosson, 2020) with the HyAB metric
// (|ΔLr| + √(Δa² + Δb²); Abasi et al. 2019).
//
// Returns 0 if below the threshold, otherwise ±1 (negative if the img2 pixel is
// darker). Caller guarantees the two pixels differ.
func colorDelta(img1, img2 []byte, k, m int, checkerboard bool, maxDelta float64, cache *oklabCache) int {
	r1 := img1[k]
	g1 := img1[k+1]
	b1 := img1[k+2]
	a1 := img1[k+3]
	r2 := img2[m]
	g2 := img2[m+1]
	b2 := img2[m+2]
	a2 := img2[m+3]

	if a1 == 255 && a2 == 255 { // fast path for opaque colors
		return colorDeltaOpaque(r1, g1, b1, r2, g2, b2, maxDelta, cache)
	}

	return colorDeltaTransparent(r1, g1, b1, a1, r2, g2, b2, a2, k, checkerboard, maxDelta)
}

func colorDeltaOpaque(r1, g1, b1, r2, g2, b2 uint8, maxDelta float64, cache *oklabCache) int {
	key1 := uint32(r1)<<16 | uint32(g1)<<8 | uint32(b1)
	slot1 := (key1 * 0x9e3779b1) >> oklabCacheShift
	stored1 := key1 + 1
	offset1 := slot1 * 4
	var l1, m1, s1, lr1 float64
	if cache.keys[slot1] == stored1 {
		l1 = cache.values[offset1]
		m1 = cache.values[offset1+1]
		s1 = cache.values[offset1+2]
		lr1 = cache.values[offset1+3]
	} else {
		l1 = cbrtLUT(lR[r1] + lG[g1] + lB[b1])
		m1 = cbrtLUT(mR[r1] + mG[g1] + mB[b1])
		s1 = cbrtLUT(sR[r1] + sG[g1] + sB[b1])
		lr1 = toe(0.2104542553*l1 + 0.7936177850*m1 - 0.0040720468*s1)
		cache.keys[slot1] = stored1
		cache.values[offset1] = l1
		cache.values[offset1+1] = m1
		cache.values[offset1+2] = s1
		cache.values[offset1+3] = lr1
	}

	key2 := uint32(r2)<<16 | uint32(g2)<<8 | uint32(b2)
	slot2 := (key2 * 0x9e3779b1) >> oklabCacheShift
	stored2 := key2 + 1
	offset2 := slot2 * 4
	var l2, m2, s2, lr2 float64
	if cache.keys[slot2] == stored2 {
		l2 = cache.values[offset2]
		m2 = cache.values[offset2+1]
		s2 = cache.values[offset2+2]
		lr2 = cache.values[offset2+3]
	} else {
		l2 = cbrtLUT(lR[r2] + lG[g2] + lB[b2])
		m2 = cbrtLUT(mR[r2] + mG[g2] + mB[b2])
		s2 = cbrtLUT(sR[r2] + sG[g2] + sB[b2])
		lr2 = toe(0.2104542553*l2 + 0.7936177850*m2 - 0.0040720468*s2)
		cache.keys[slot2] = stored2
		cache.values[offset2] = l2
		cache.values[offset2+1] = m2
		cache.values[offset2+2] = s2
		cache.values[offset2+3] = lr2
	}

	return oklabHyabDelta(lr1-lr2, l1-l2, m1-m2, s1-s2, maxDelta)
}

func colorDeltaTransparent(r1b, g1b, b1b, a1b, r2b, g2b, b2b, a2b uint8, k int, checkerboard bool, maxDelta float64) int {
	// blend pixels with background
	rb, gb, bb := 255.0, 255.0, 255.0
	if checkerboard {
		rb = 48 + 159*float64(k%2)
		gb = 48 + 159*float64(int(float64(k)/1.618033988749895)%2)
		bb = 48 + 159*float64(int(float64(k)/2.618033988749895)%2)
	}
	a1 := float64(a1b)
	a2 := float64(a2b)
	// blended channel values are fractional, so interpolate the sRGB->linear LUT
	r1 := (float64(r1b)*a1 + rb*(255-a1)) / 255
	g1 := (float64(g1b)*a1 + gb*(255-a1)) / 255
	b1 := (float64(b1b)*a1 + bb*(255-a1)) / 255
	r2 := (float64(r2b)*a2 + rb*(255-a2)) / 255
	g2 := (float64(g2b)*a2 + gb*(255-a2)) / 255
	b2 := (float64(b2b)*a2 + bb*(255-a2)) / 255
	lr1, lg1, lb1 := linLUT(r1), linLUT(g1), linLUT(b1)
	lr2, lg2, lb2 := linLUT(r2), linLUT(g2), linLUT(b2)

	l1 := cbrtLUT(0.4122214708*lr1 + 0.5363325363*lg1 + 0.0514459929*lb1)
	m1 := cbrtLUT(0.2119034982*lr1 + 0.6806995451*lg1 + 0.1073969566*lb1)
	s1 := cbrtLUT(0.0883024619*lr1 + 0.2817188376*lg1 + 0.6299787005*lb1)
	l2 := cbrtLUT(0.4122214708*lr2 + 0.5363325363*lg2 + 0.0514459929*lb2)
	m2 := cbrtLUT(0.2119034982*lr2 + 0.6806995451*lg2 + 0.1073969566*lb2)
	s2 := cbrtLUT(0.0883024619*lr2 + 0.2817188376*lg2 + 0.6299787005*lb2)
	bigLr1 := toe(0.2104542553*l1 + 0.7936177850*m1 - 0.0040720468*s1)
	bigLr2 := toe(0.2104542553*l2 + 0.7936177850*m2 - 0.0040720468*s2)

	return oklabHyabDelta(bigLr1-bigLr2, l1-l2, m1-m2, s1-s2, maxDelta)
}

func oklabHyabDelta(dLr, dl, dm, ds, maxDelta float64) int {
	// HyAB distance = |dLr| + sqrt(da^2 + db^2); compare against maxDelta without the sqrt:
	// it stays below the threshold iff |dLr| <= maxDelta and da^2 + db^2 <= (maxDelta - |dLr|)^2
	rest := maxDelta - math.Abs(dLr)
	if rest > 0 {
		da := 1.9779984951*dl - 2.4285922050*dm + 0.4505937099*ds
		db := 0.0259040371*dl + 0.7827717662*dm - 0.8086757660*ds
		if da*da+db*db <= rest*rest {
			return 0
		}
	}

	// encode whether the pixel lightens or darkens in the sign
	if dLr > 0 {
		return -1
	}
	return 1
}

func toe(bigL float64) float64 {
	x := toeK3*bigL - toeK1
	return 0.5 * (x + math.Sqrt(x*x+4*toeK2*toeK3*bigL))
}
