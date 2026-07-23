package anthropic

import (
	"encoding/base64"
	"testing"
)

func TestSniffImageDimensions(t *testing.T) {
	tests := []struct {
		name   string
		bytes  []byte
		width  int
		height int
	}{
		{name: "PNG", bytes: pngHeader(2560, 1440), width: 2560, height: 1440},
		{name: "JPEG", bytes: jpegHeader(3024, 1964), width: 3024, height: 1964},
		{name: "GIF", bytes: []byte{'G', 'I', 'F', '8', '9', 'a', 64, 1, 240, 0}, width: 320, height: 240},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded := base64.StdEncoding.EncodeToString(test.bytes)
			dims, ok := SniffImageDimensions(encoded)
			if !ok || dims.Width != test.width || dims.Height != test.height {
				t.Fatalf("dimensions = %#v, %v", dims, ok)
			}
			dataURL := "data:image/" + test.name + ";base64," + encoded
			if parsed, ok := ParseImageDimensions(dataURL); !ok || parsed != dims {
				t.Fatalf("data URL dimensions = %#v, %v", parsed, ok)
			}
		})
	}
	if _, ok := SniffImageDimensions("not-base64!"); ok {
		t.Fatal("malformed base64 unexpectedly parsed")
	}
}

func TestEnforceAnthropicImageLimitsDropsOldestRiskyImages(t *testing.T) {
	small := imageBlock(base64.StdEncoding.EncodeToString(pngHeader(800, 600)))
	large := imageBlock(base64.StdEncoding.EncodeToString(pngHeader(2400, 1600)))
	content := make([]any, 0, 25)
	for range 24 {
		content = append(content, cloneImageBlock(small))
	}
	content = append(content, large)
	messages := []any{map[string]any{"role": "user", "content": content}}

	EnforceAnthropicImageLimits(messages)

	if got := countImageBlocks(messages); got != ManyImageThreshold {
		t.Fatalf("image count = %d, want %d", got, ManyImageThreshold)
	}
	for index := range 5 {
		block := content[index].(map[string]any)
		if block["type"] != "text" {
			t.Fatalf("old image %d was not textified: %#v", index, block)
		}
	}
	if content[len(content)-1].(map[string]any)["type"] != "image" {
		t.Fatal("newest large image was dropped")
	}
}

func TestEnforceAnthropicImageLimitsAbsoluteAndCountCaps(t *testing.T) {
	huge := imageBlock(base64.StdEncoding.EncodeToString(pngHeader(9000, 500)))
	content := []any{huge}
	for range 105 {
		content = append(content, imageBlock(base64.StdEncoding.EncodeToString(pngHeader(100, 100))))
	}
	messages := []any{map[string]any{"role": "user", "content": content}}
	EnforceAnthropicImageLimits(messages)
	if content[0].(map[string]any)["type"] != "text" {
		t.Fatal("absolute-dimension offender was not textified")
	}
	if got := countImageBlocks(messages); got != MaxImagesPerRequest {
		t.Fatalf("image count = %d, want %d", got, MaxImagesPerRequest)
	}
}

func pngHeader(width, height int) []byte {
	return []byte{
		0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
		0, 0, 0, 13, 'I', 'H', 'D', 'R',
		byte(width >> 24), byte(width >> 16), byte(width >> 8), byte(width),
		byte(height >> 24), byte(height >> 16), byte(height >> 8), byte(height),
		8, 6, 0, 0, 0,
	}
}

func jpegHeader(width, height int) []byte {
	return []byte{
		0xff, 0xd8,
		0xff, 0xe1, 0, 4, 0, 0,
		0xff, 0xc0, 0, 17, 8,
		byte(height >> 8), byte(height), byte(width >> 8), byte(width), 3, 0, 0, 0, 0, 0, 0,
	}
}

func imageBlock(data string) map[string]any {
	return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": data}}
}

func cloneImageBlock(block map[string]any) map[string]any {
	source := block["source"].(map[string]any)
	return map[string]any{"type": "image", "source": map[string]any{"type": source["type"], "media_type": source["media_type"], "data": source["data"]}}
}

func countImageBlocks(messages []any) int {
	count := 0
	var scan func([]any)
	scan = func(blocks []any) {
		for _, raw := range blocks {
			block, _ := raw.(map[string]any)
			if block["type"] == "image" {
				count++
			} else if block["type"] == "tool_result" {
				if nested, ok := block["content"].([]any); ok {
					scan(nested)
				}
			}
		}
	}
	for _, raw := range messages {
		message := raw.(map[string]any)
		if content, ok := message["content"].([]any); ok {
			scan(content)
		}
	}
	return count
}
