package visual

import (
	"bytes"
	"fmt"
	"image"

	// Registered for their side effect on image.Decode.
	_ "image/jpeg"
	_ "image/png"

	_ "golang.org/x/image/webp"
)

// Decode decodes a PNG, WebP or JPEG screenshot.
func Decode(data []byte) (image.Image, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode screenshot: %w", err)
	}
	return img, nil
}
