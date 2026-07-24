package vision

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"strings"
	"sync"
	"testing"
	"time"

	shared "github.com/lidge-jun/opencodex-go/internal/types"
)

var onePixelPNG, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")

func TestParseImageValidation(t *testing.T) {
	valid := dataURL(onePixelPNG)
	image, err := ParseImage(valid, ValidationOptions{})
	if err != nil {
		t.Fatalf("ParseImage(valid): %v", err)
	}
	if image.MediaType != "image/png" || image.Width != 1 || image.Height != 1 {
		t.Fatalf("image = %#v", image)
	}

	tests := []struct {
		name  string
		value string
		opts  ValidationOptions
	}{
		{name: "mime", value: strings.Replace(valid, "image/png", "text/plain", 1)},
		{name: "base64", value: "data:image/png;base64,%%%"},
		{name: "size", value: valid, opts: ValidationOptions{MaxBytes: 8}},
		{name: "dimensions", value: dataURL(pngImage(t, 2, 1)), opts: ValidationOptions{MaxEdge: 1, MaxPixels: 2, MaxBytes: 1 << 20}},
		{name: "scheme", value: "http://example.com/image.png"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ParseImage(test.value, test.opts); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestDescriptionCacheHitMissExpiryAndBound(t *testing.T) {
	now := time.Unix(100, 0)
	cache := NewDescriptionCache(1, time.Minute)
	cache.now = func() time.Time { return now }
	if _, ok := cache.Get("a"); ok {
		t.Fatal("unexpected cache hit")
	}
	cache.Set("a", "first")
	if value, ok := cache.Get("a"); !ok || value != "first" {
		t.Fatalf("cache hit = %q, %v", value, ok)
	}
	cache.Set("b", "second")
	if _, ok := cache.Get("a"); ok {
		t.Fatal("oldest entry was not evicted")
	}
	now = now.Add(time.Minute)
	if _, ok := cache.Get("b"); ok {
		t.Fatal("expired entry returned as a hit")
	}
}

func TestVisionPreprocessorConcurrentDescriptionDeduplicates(t *testing.T) {
	describer := newBarrierDescriber(3)
	preprocessor := NewVisionPreprocessor(PreprocessorConfig{
		Describer: describer, TextOnlyModels: []string{"text-only"}, MaxDescriptionsPerTurn: 8,
	})
	request := imageRequest("text-only", []string{
		dataURL(append(append([]byte(nil), onePixelPNG...), 1)),
		dataURL(append(append([]byte(nil), onePixelPNG...), 2)),
		dataURL(append(append([]byte(nil), onePixelPNG...), 3)),
		dataURL(append(append([]byte(nil), onePixelPNG...), 1)),
	})
	if err := preprocessor.Preprocess(context.Background(), request); err != nil {
		t.Fatalf("Preprocess: %v", err)
	}
	if describer.calls != 3 {
		t.Fatalf("Describe calls = %d, want 3 unique images", describer.calls)
	}
	if describer.maxActive > MaxVisionConcurrency {
		t.Fatalf("max active = %d, want <= %d", describer.maxActive, MaxVisionConcurrency)
	}
	if count := strings.Count(string(request.Context.Messages[0].Content), "[Image: described-"); count != 4 {
		t.Fatalf("replacement count = %d; content = %s", count, request.Context.Messages[0].Content)
	}
	second := imageRequest("text-only", []string{dataURL(append(append([]byte(nil), onePixelPNG...), 1))})
	if err := preprocessor.Preprocess(context.Background(), second); err != nil {
		t.Fatalf("cached Preprocess: %v", err)
	}
	if describer.calls != 3 {
		t.Fatalf("cache miss: Describe calls = %d", describer.calls)
	}
}

func TestReplaceImagesAndNoSidecarFallback(t *testing.T) {
	url := dataURL(onePixelPNG)
	request := imageRequest("text-only", []string{url})
	image, err := ParseImage(url, ValidationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := ReplaceImages(request, map[string]string{imageIdentity(image): "a tiny pixel"})
	if err != nil || !replaced {
		t.Fatalf("ReplaceImages = %v, %v", replaced, err)
	}
	if !strings.Contains(string(request.Context.Messages[0].Content), "[Image: a tiny pixel]") {
		t.Fatalf("content = %s", request.Context.Messages[0].Content)
	}

	request = imageRequest("text-only", []string{url})
	preprocessor := NewVisionPreprocessor(PreprocessorConfig{TextOnlyModels: []string{"text-only"}})
	if err := preprocessor.Preprocess(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(request.Context.Messages[0].Content), NoSidecarReplacement) {
		t.Fatalf("fallback content = %s", request.Context.Messages[0].Content)
	}
}

type barrierDescriber struct {
	want      int
	mu        sync.Mutex
	calls     int
	active    int
	maxActive int
	release   chan struct{}
	once      sync.Once
}

func newBarrierDescriber(want int) *barrierDescriber {
	return &barrierDescriber{want: want, release: make(chan struct{})}
}

func (d *barrierDescriber) Describe(_ context.Context, _ Image, _ string) (string, error) {
	d.mu.Lock()
	d.calls++
	d.active++
	call := d.calls
	if d.active > d.maxActive {
		d.maxActive = d.active
	}
	if d.calls == d.want {
		d.once.Do(func() { close(d.release) })
	}
	d.mu.Unlock()
	<-d.release
	d.mu.Lock()
	d.active--
	d.mu.Unlock()
	return fmt.Sprintf("described-%d", call), nil
}

func dataURL(data []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
}

func pngImage(t *testing.T, width, height int) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := png.Encode(&output, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatalf("encode PNG fixture: %v", err)
	}
	return output.Bytes()
}

func imageRequest(model string, urls []string) *shared.NormalizedRequest {
	parts := []any{map[string]any{"type": "text", "text": "What is shown?"}}
	for _, value := range urls {
		parts = append(parts, map[string]any{"type": "image", "imageUrl": value, "detail": "high"})
	}
	content, _ := json.Marshal(parts)
	return &shared.NormalizedRequest{ModelID: model, Context: shared.RequestContext{Messages: []shared.Message{{Role: "user", Content: content}}}}
}
