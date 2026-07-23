package anthropic

import (
	"encoding/base64"
	"strings"
)

const (
	ManyImageThreshold       = 20
	ManyImageMaxDimension    = 2000
	AbsoluteMaxDimension     = 8000
	MaxImagesPerRequest      = 100
	MaxImageBase64Length     = 5 * 1024 * 1024
	TotalImageBase64Budget   = 20 * 1024 * 1024
	imageHeaderBase64Limit   = 65536
	omittedImageText         = "[image omitted: Anthropic request exceeded the 20-image limit for large images; older screenshots were dropped]"
	oversizedImageText       = "[image omitted: exceeds Anthropic's 8000px per-side limit]"
	perImageTooLargeText     = "[image omitted: exceeds Anthropic's 5MB per-image limit]"
	imagePayloadOverflowText = "[image omitted: total image payload exceeded Anthropic's 32MB request limit; older screenshots were dropped]"
)

type ImageDimensions struct {
	Width  int
	Height int
}

// ParseImageDimensions reads dimensions from raw base64 or a base64 data URL.
// Remote URLs intentionally return false because request building must not fetch them.
func ParseImageDimensions(value string) (ImageDimensions, bool) {
	if strings.HasPrefix(value, "data:") {
		comma := strings.IndexByte(value, ',')
		if comma < 0 || !strings.Contains(strings.ToLower(value[:comma]), ";base64") {
			return ImageDimensions{}, false
		}
		value = value[comma+1:]
	}
	return SniffImageDimensions(value)
}

func SniffImageDimensions(value string) (ImageDimensions, bool) {
	if len(value) > imageHeaderBase64Limit {
		value = value[:imageHeaderBase64Limit]
	}
	value = value[:len(value)-len(value)%4]
	if value == "" {
		return ImageDimensions{}, false
	}
	bytes, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return ImageDimensions{}, false
	}
	if dims, ok := pngDimensions(bytes); ok {
		return dims, true
	}
	if dims, ok := jpegDimensions(bytes); ok {
		return dims, true
	}
	if dims, ok := gifDimensions(bytes); ok {
		return dims, true
	}
	return webpDimensions(bytes)
}

func pngDimensions(b []byte) (ImageDimensions, bool) {
	if len(b) < 24 || b[0] != 0x89 || string(b[1:4]) != "PNG" {
		return ImageDimensions{}, false
	}
	return ImageDimensions{Width: int(u32be(b, 16)), Height: int(u32be(b, 20))}, true
}

func jpegDimensions(b []byte) (ImageDimensions, bool) {
	if len(b) < 4 || b[0] != 0xff || b[1] != 0xd8 {
		return ImageDimensions{}, false
	}
	for offset := 2; offset+9 < len(b); {
		if b[offset] != 0xff {
			offset++
			continue
		}
		marker := b[offset+1]
		if marker == 0xff {
			offset++
			continue
		}
		if marker == 0x01 || marker >= 0xd0 && marker <= 0xd7 {
			offset += 2
			continue
		}
		if marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc {
			return ImageDimensions{Width: int(u16be(b, offset+7)), Height: int(u16be(b, offset+5))}, true
		}
		if marker == 0xd9 || marker == 0xda || offset+4 > len(b) {
			return ImageDimensions{}, false
		}
		length := int(u16be(b, offset+2))
		if length < 2 || offset+2+length > len(b) {
			return ImageDimensions{}, false
		}
		offset += 2 + length
	}
	return ImageDimensions{}, false
}

func gifDimensions(b []byte) (ImageDimensions, bool) {
	if len(b) < 10 || string(b[:3]) != "GIF" {
		return ImageDimensions{}, false
	}
	return ImageDimensions{Width: int(u16le(b, 6)), Height: int(u16le(b, 8))}, true
}

func webpDimensions(b []byte) (ImageDimensions, bool) {
	if len(b) < 30 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return ImageDimensions{}, false
	}
	switch string(b[12:16]) {
	case "VP8X":
		return ImageDimensions{Width: int(u24le(b, 24)) + 1, Height: int(u24le(b, 27)) + 1}, true
	case "VP8 ":
		if b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a {
			return ImageDimensions{}, false
		}
		return ImageDimensions{Width: int(u16le(b, 26) & 0x3fff), Height: int(u16le(b, 28) & 0x3fff)}, true
	case "VP8L":
		if b[20] != 0x2f {
			return ImageDimensions{}, false
		}
		raw := uint32(b[21]) | uint32(b[22])<<8 | uint32(b[23])<<16 | uint32(b[24])<<24
		return ImageDimensions{Width: int(raw&0x3fff) + 1, Height: int((raw>>14)&0x3fff) + 1}, true
	default:
		return ImageDimensions{}, false
	}
}

func u16be(b []byte, offset int) uint16 { return uint16(b[offset])<<8 | uint16(b[offset+1]) }
func u32be(b []byte, offset int) uint32 {
	return uint32(b[offset])<<24 | uint32(b[offset+1])<<16 | uint32(b[offset+2])<<8 | uint32(b[offset+3])
}
func u16le(b []byte, offset int) uint16 { return uint16(b[offset]) | uint16(b[offset+1])<<8 }
func u24le(b []byte, offset int) uint32 {
	return uint32(b[offset]) | uint32(b[offset+1])<<8 | uint32(b[offset+2])<<16
}

type imageRef struct {
	container *[]any
	index     int
	base64    string
	hasData   bool
}

func collectImageRefs(messages []any) []imageRef {
	refs := make([]imageRef, 0)
	var scan func(*[]any)
	scan = func(blocks *[]any) {
		for index, raw := range *blocks {
			block, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "image":
				ref := imageRef{container: blocks, index: index}
				if source, ok := block["source"].(map[string]any); ok && source["type"] == "base64" {
					ref.base64, ref.hasData = source["data"].(string)
				}
				refs = append(refs, ref)
			case "tool_result":
				if nested, ok := block["content"].([]any); ok {
					scan(&nested)
				}
			}
		}
	}
	for _, raw := range messages {
		message, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if content, ok := message["content"].([]any); ok {
			scan(&content)
		}
	}
	return refs
}

func (ref imageRef) textify(text string) {
	(*ref.container)[ref.index] = map[string]any{"type": "text", "text": text}
}

func EnforceAnthropicImageLimits(messages []any) {
	refs := collectImageRefs(messages)
	if len(refs) == 0 {
		return
	}
	dimensions := make([]ImageDimensions, len(refs))
	known := make([]bool, len(refs))
	live := make([]bool, len(refs))
	liveCount := len(refs)
	for index, ref := range refs {
		live[index] = true
		if ref.hasData {
			dimensions[index], known[index] = SniffImageDimensions(ref.base64)
		}
	}
	drop := func(index int, text string) {
		if live[index] {
			refs[index].textify(text)
			live[index] = false
			liveCount--
		}
	}
	for index, dims := range dimensions {
		if known[index] && (dims.Width > AbsoluteMaxDimension || dims.Height > AbsoluteMaxDimension) {
			drop(index, oversizedImageText)
		}
	}
	for index, ref := range refs {
		if live[index] && ref.hasData && len(ref.base64) > MaxImageBase64Length {
			drop(index, perImageTooLargeText)
		}
	}
	risky := false
	for index, dims := range dimensions {
		if live[index] && (!known[index] || dims.Width > ManyImageMaxDimension || dims.Height > ManyImageMaxDimension) {
			risky = true
			break
		}
	}
	if risky {
		for index := range refs {
			if liveCount <= ManyImageThreshold {
				break
			}
			drop(index, omittedImageText)
		}
	}
	for index := range refs {
		if liveCount <= MaxImagesPerRequest {
			break
		}
		drop(index, omittedImageText)
	}
	total := 0
	for index, ref := range refs {
		if live[index] && ref.hasData {
			total += len(ref.base64)
		}
	}
	for index, ref := range refs {
		if total <= TotalImageBase64Budget {
			break
		}
		if live[index] && ref.hasData {
			drop(index, imagePayloadOverflowText)
			total -= len(ref.base64)
		}
	}
}
