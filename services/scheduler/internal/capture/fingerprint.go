package capture

import (
	"crypto/sha256"
	"hash/fnv"
	"image"
	"math/bits"
	"strings"
)

// Fingerprints are the cheap identities of a normalized Capture.
type Fingerprints struct {
	// TextHash is sha256 over the normalized comparison text of every block
	// that is not ignored, in order.
	TextHash []byte
	// SimHash is a 64-bit SimHash over word 3-shingles of the same text.
	SimHash uint64
	// DHash is a 64-bit difference hash of the screenshot, or nil without one.
	DHash *uint64
}

// TextFingerprint hashes the normalized comparison text of a Capture. Pass
// the Compare strings of the blocks that are not ignored.
func TextFingerprint(compare []string) (textHash []byte, simhash uint64) {
	h := sha256.New()
	for _, s := range compare {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	return h.Sum(nil), SimHash(strings.Join(compare, " "))
}

// SimHash computes a 64-bit SimHash over word 3-shingles (Manku et al.).
func SimHash(text string) uint64 {
	words := strings.Fields(text)
	if len(words) == 0 {
		return 0
	}
	var weights [64]int
	add := func(shingle string) {
		h := fnv.New64a()
		h.Write([]byte(shingle))
		v := h.Sum64()
		for i := range 64 {
			if v&(1<<i) != 0 {
				weights[i]++
			} else {
				weights[i]--
			}
		}
	}
	if len(words) < 3 {
		add(strings.Join(words, " "))
	} else {
		for i := 0; i+3 <= len(words); i++ {
			add(words[i] + " " + words[i+1] + " " + words[i+2])
		}
	}
	var out uint64
	for i, w := range weights {
		if w > 0 {
			out |= 1 << i
		}
	}
	return out
}

// Hamming is the number of differing bits between two 64-bit hashes.
func Hamming(a, b uint64) int { return bits.OnesCount64(a ^ b) }

// DHash computes a 64-bit difference hash: the image is reduced to 9×8
// greyscale cells and each bit records whether a cell is brighter than its
// right neighbour.
func DHash(img image.Image) uint64 {
	b := img.Bounds()
	if b.Empty() {
		return 0
	}
	var cells [8][9]float64
	for cy := range 8 {
		for cx := range 9 {
			x0 := b.Min.X + cx*b.Dx()/9
			x1 := b.Min.X + (cx+1)*b.Dx()/9
			y0 := b.Min.Y + cy*b.Dy()/8
			y1 := b.Min.Y + (cy+1)*b.Dy()/8
			if x1 <= x0 {
				x1 = x0 + 1
			}
			if y1 <= y0 {
				y1 = y0 + 1
			}
			// Sample a sparse grid inside the cell: a full average over a
			// 1366×8000 page would dominate the fast path it exists for.
			var sum float64
			var n int
			stepX := max(1, (x1-x0)/8)
			stepY := max(1, (y1-y0)/8)
			for y := y0; y < y1 && y < b.Max.Y; y += stepY {
				for x := x0; x < x1 && x < b.Max.X; x += stepX {
					r, g, bl, _ := img.At(x, y).RGBA()
					sum += 0.299*float64(r) + 0.587*float64(g) + 0.114*float64(bl)
					n++
				}
			}
			if n > 0 {
				cells[cy][cx] = sum / float64(n)
			}
		}
	}
	var out uint64
	bit := 0
	for cy := range 8 {
		for cx := range 8 {
			if cells[cy][cx] > cells[cy][cx+1] {
				out |= 1 << bit
			}
			bit++
		}
	}
	return out
}
