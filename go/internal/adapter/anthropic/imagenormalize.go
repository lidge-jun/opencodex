package anthropic

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"math"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	MaxInputBase64Length = 64 * 1024 * 1024
	MaxInputPixels       = 100_000_000
	maxDecodedImageBytes = 48 * 1024 * 1024
	undecodableImageText = "[image omitted: undecodable or corrupt image data]"
	unsafeImageText      = "[image omitted: image too large to process safely]"
)

type imageTier struct {
	maxEdge   int
	qualities []int
	hardCap   int
}

var imageTiers = []imageTier{
	{maxEdge: 2000, qualities: []int{80, 60, 40, 30}, hardCap: 2 * 1024 * 1024},
	{maxEdge: 1024, qualities: []int{70, 50}, hardCap: 512 * 1024},
	{maxEdge: 700, qualities: []int{60, 40}, hardCap: 192 * 1024},
	{maxEdge: 500, qualities: []int{40}, hardCap: 100 * 1024},
	{maxEdge: 400, qualities: []int{30}, hardCap: 100 * 1024},
	{maxEdge: 320, qualities: []int{25}, hardCap: math.MaxInt},
}

type normalizedImage struct {
	ref      imageRef
	source   string
	media    string
	position int
	size     int
	done     bool
}

// NormalizeAnthropicImages resizes/re-encodes base64 images in place. It uses
// age-based tiers, retaining more fidelity for the newest screenshots.
func NormalizeAnthropicImages(messages []any) error {
	refs := collectImageRefs(messages)
	entries := make([]*normalizedImage, len(refs))
	for index, ref := range refs {
		if !ref.hasData {
			continue
		}
		if len(refs)-1-index >= MaxImagesPerRequest {
			continue
		}
		if len(ref.base64) > MaxInputBase64Length || base64.StdEncoding.DecodedLen(len(ref.base64)) > maxDecodedImageBytes {
			ref.textify(unsafeImageText)
			continue
		}
		dims, known := SniffImageDimensions(ref.base64)
		if known && exceedsPixelLimit(dims) {
			ref.textify(unsafeImageText)
			continue
		}
		media := imageMediaType(ref)
		position := initialTier(len(refs) - 1 - index)
		result, err := normalizeAt(ref.base64, media, position)
		if err != nil {
			ref.textify(undecodableImageText)
			continue
		}
		if result.data != ref.base64 {
			replaceImage(ref, result.data, "image/jpeg")
		}
		entries[index] = &normalizedImage{
			ref: ref, source: ref.base64, media: media, position: result.position,
			size: len(result.data), done: result.position == len(imageTiers)-1,
		}
	}

	total := normalizedTotal(entries)
	for total > TotalImageBase64Budget {
		entry := oldestDemotable(entries)
		if entry == nil {
			break
		}
		result, err := normalizeAt(entry.source, entry.media, entry.position+1)
		if err != nil {
			entry.ref.textify(undecodableImageText)
			total -= entry.size
			entries[indexOfEntry(entries, entry)] = nil
			continue
		}
		replaceImage(entry.ref, result.data, "image/jpeg")
		total += len(result.data) - entry.size
		entry.size = len(result.data)
		entry.position = result.position
		entry.done = result.position == len(imageTiers)-1
	}
	return nil
}

type normalizeResult struct {
	data     string
	position int
}

func normalizeAt(source, media string, start int) (normalizeResult, error) {
	decoded, err := base64.StdEncoding.DecodeString(source)
	if err != nil {
		return normalizeResult{}, fmt.Errorf("decode image base64: %w", err)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(decoded))
	if err != nil {
		return normalizeResult{}, fmt.Errorf("decode image config: %w", err)
	}
	dims := ImageDimensions{Width: config.Width, Height: config.Height}
	if exceedsPixelLimit(dims) {
		return normalizeResult{}, fmt.Errorf("image dimensions exceed safe pixel limit")
	}

	for position := start; position < len(imageTiers); position++ {
		tier := imageTiers[position]
		if isAnthropicImageMedia(media) && dims.Width <= tier.maxEdge && dims.Height <= tier.maxEdge && len(source) <= tier.hardCap {
			if _, _, err := image.Decode(bytes.NewReader(decoded)); err != nil {
				return normalizeResult{}, fmt.Errorf("validate image: %w", err)
			}
			return normalizeResult{data: source, position: position}, nil
		}
		img, _, err := image.Decode(bytes.NewReader(decoded))
		if err != nil {
			return normalizeResult{}, fmt.Errorf("decode image: %w", err)
		}
		resized := resizeToFit(img, tier.maxEdge)
		var last string
		for _, quality := range tier.qualities {
			var output bytes.Buffer
			if err := jpeg.Encode(&output, resized, &jpeg.Options{Quality: quality}); err != nil {
				return normalizeResult{}, fmt.Errorf("encode image: %w", err)
			}
			last = base64.StdEncoding.EncodeToString(output.Bytes())
			if len(last) <= tier.hardCap {
				return normalizeResult{data: last, position: position}, nil
			}
		}
		if position == len(imageTiers)-1 && last != "" {
			return normalizeResult{data: last, position: position}, nil
		}
	}
	return normalizeResult{}, fmt.Errorf("image could not be normalized")
}

func exceedsPixelLimit(dims ImageDimensions) bool {
	if dims.Width <= 0 || dims.Height <= 0 {
		return true
	}
	return int64(dims.Width) > int64(MaxInputPixels)/int64(dims.Height)
}

func resizeToFit(source image.Image, maxEdge int) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= maxEdge && height <= maxEdge {
		return source
	}
	scale := float64(maxEdge) / float64(max(width, height))
	targetWidth := max(1, int(math.Round(float64(width)*scale)))
	targetHeight := max(1, int(math.Round(float64(height)*scale)))
	target := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	draw.CatmullRom.Scale(target, target.Bounds(), source, bounds, draw.Over, nil)
	return target
}

func initialTier(newestIndex int) int {
	if newestIndex < 6 {
		return 0
	}
	if newestIndex < 20 {
		return 1
	}
	return 2
}

func imageMediaType(ref imageRef) string {
	block, _ := (*ref.container)[ref.index].(map[string]any)
	source, _ := block["source"].(map[string]any)
	media, _ := source["media_type"].(string)
	return strings.ToLower(media)
}

func isAnthropicImageMedia(media string) bool {
	switch media {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func replaceImage(ref imageRef, data, media string) {
	(*ref.container)[ref.index] = map[string]any{
		"type":   "image",
		"source": map[string]any{"type": "base64", "media_type": media, "data": data},
	}
}

func normalizedTotal(entries []*normalizedImage) int {
	total := 0
	for _, entry := range entries {
		if entry != nil {
			total += entry.size
		}
	}
	return total
}

func oldestDemotable(entries []*normalizedImage) *normalizedImage {
	for _, entry := range entries {
		if entry != nil && !entry.done {
			return entry
		}
	}
	return nil
}

func indexOfEntry(entries []*normalizedImage, target *normalizedImage) int {
	for index, entry := range entries {
		if entry == target {
			return index
		}
	}
	return -1
}
