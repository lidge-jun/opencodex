package anthropic

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestNormalizeAnthropicImagesResizesOversizedImage(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 2401, 20))
	for x := 0; x < source.Bounds().Dx(); x++ {
		for y := 0; y < source.Bounds().Dy(); y++ {
			source.SetRGBA(x, y, color.RGBA{R: byte(x), G: byte(y), B: 80, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	block := imageBlock(base64.StdEncoding.EncodeToString(encoded.Bytes()))
	messages := []any{map[string]any{"role": "user", "content": []any{block}}}
	if err := NormalizeAnthropicImages(messages); err != nil {
		t.Fatal(err)
	}
	normalized := messages[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	normalizedSource := normalized["source"].(map[string]any)
	if normalizedSource["media_type"] != "image/jpeg" {
		t.Fatalf("media type = %#v", normalizedSource["media_type"])
	}
	dims, ok := SniffImageDimensions(normalizedSource["data"].(string))
	if !ok || dims.Width > ManyImageMaxDimension || dims.Height > ManyImageMaxDimension {
		t.Fatalf("normalized dimensions = %#v, %v", dims, ok)
	}
}
