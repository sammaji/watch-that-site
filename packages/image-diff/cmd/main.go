// Command imgdiff compares two PNG images pixel by pixel.
//
// It mirrors the upstream pixelmatch CLI (same positional arguments, output and
// exit codes) and adds bounding-box rendering, which upstream does not have:
//
//	imgdiff a.png b.png diff.png 0.1
//	imgdiff -boxes boxes.png a.png b.png
//
// Exit codes: 0 identical, 64 usage, 65 dimension mismatch, 66 images differ.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"time"

	imagediff "github.com/sammaji/watchthatsite/packages/image-diff/imagediff"
)

const (
	exitUsage    = 64
	exitMismatch = 65
	exitDiffers  = 66
)

func main() {
	var (
		boxesPath  = flag.String("boxes", "", "write the second image annotated with bounding boxes to this PNG")
		blockSize  = flag.Int("block", 8, "bounding box grid block size in pixels")
		mergeGap   = flag.Int("gap", 1, "merge changed areas within this many blocks of each other")
		minPixels  = flag.Int("min-pixels", 0, "drop regions with fewer than this many changed pixels")
		padding    = flag.Int("padding", 2, "pixels of padding around each bounding box")
		thickness  = flag.Int("thickness", 2, "bounding box stroke width in pixels")
		windowSize = flag.Int("window", 0, "report the max diff pixels in any NxN window instead of the total")
		includeAA  = flag.Bool("include-aa", false, "count anti-aliased pixels as differences")
		asJSON     = flag.Bool("json", false, "print the result as JSON")
		workers    = flag.Int("workers", 0, "comparison goroutines (0 = GOMAXPROCS)")
	)
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: imgdiff [flags] image1.png image2.png [diff.png] [threshold] [includeAA]")
		flag.PrintDefaults()
	}
	flag.Parse()

	args := flag.Args()
	if len(args) < 2 {
		flag.Usage()
		os.Exit(exitUsage)
	}

	opts := imagediff.DefaultOptions()
	opts.IncludeAA = *includeAA
	opts.WindowSize = *windowSize
	opts.Workers = *workers

	var diffPath string
	if len(args) > 2 {
		diffPath = args[2]
	}
	if len(args) > 3 {
		if _, err := fmt.Sscanf(args[3], "%g", &opts.Threshold); err != nil {
			fatalf("invalid threshold %q: %v", args[3], err)
		}
	}
	if len(args) > 4 {
		opts.IncludeAA = args[4] != "false"
	}

	img1 := readPNG(args[0])
	img2 := readPNG(args[1])

	if img1.Bounds().Dx() != img2.Bounds().Dx() || img1.Bounds().Dy() != img2.Bounds().Dy() {
		fmt.Fprintf(os.Stderr, "Image dimensions do not match: %dx%d vs %dx%d\n",
			img1.Bounds().Dx(), img1.Bounds().Dy(), img2.Bounds().Dx(), img2.Bounds().Dy())
		os.Exit(exitMismatch)
	}

	diffOpts := &imagediff.DiffOptions{Pixelmatch: opts, RenderDiff: diffPath != ""}
	if *boxesPath != "" {
		diffOpts.Regions = &imagediff.RegionOptions{
			BlockSize:      *blockSize,
			MinBlockPixels: 1,
			MergeGap:       *mergeGap,
			MinDiffPixels:  *minPixels,
			Padding:        *padding,
			MergeOverlaps:  true,
		}
	}

	start := time.Now()
	res, err := imagediff.Diff(img1, img2, diffOpts)
	if err != nil {
		fatalf("%v", err)
	}
	elapsed := time.Since(start)

	if diffPath != "" {
		writePNG(diffPath, res.Diff)
	}
	if *boxesPath != "" {
		style := imagediff.DefaultBoxStyle()
		style.Thickness = *thickness
		style.Color = color.NRGBA{R: 255, G: 0, B: 0, A: 255}
		writePNG(*boxesPath, imagediff.RenderBoxes(img2, res.Boxes, style))
	}

	if *asJSON {
		out := struct {
			DiffPixels  int               `json:"diffPixels"`
			TotalPixels int               `json:"totalPixels"`
			Ratio       float64           `json:"ratio"`
			Width       int               `json:"width"`
			Height      int               `json:"height"`
			ElapsedMS   float64           `json:"elapsedMs"`
			Boxes       []image.Rectangle `json:"boxes,omitempty"`
		}{res.DiffPixels, res.TotalPixels, res.Ratio(), res.Width, res.Height,
			float64(elapsed.Nanoseconds()) / 1e6, res.Boxes}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(out); err != nil {
			fatalf("encode json: %v", err)
		}
	} else {
		fmt.Printf("matched in: %v\n", elapsed)
		fmt.Printf("different pixels: %d\n", res.DiffPixels)
		fmt.Printf("error: %g%%\n", float64(int(100*100*res.Ratio()+0.5))/100)
		if *boxesPath != "" {
			fmt.Printf("changed regions: %d\n", len(res.Boxes))
		}
	}

	if res.DiffPixels != 0 {
		os.Exit(exitDiffers)
	}
}

func readPNG(path string) image.Image {
	f, err := os.Open(path)
	if err != nil {
		fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		fatalf("decode %s: %v", path, err)
	}
	return img
}

func writePNG(path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		fatalf("create %s: %v", path, err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		fatalf("encode %s: %v", path, err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "imgdiff: "+format+"\n", args...)
	os.Exit(1)
}
