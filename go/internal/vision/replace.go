package vision

import (
	"encoding/json"
	"fmt"
	"strings"

	shared "github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	NoSidecarReplacement = "[Image omitted: no vision sidecar configured]"
	sidecarFailedText    = "[Image omitted: vision sidecar could not describe the image]"
)

type requestImage struct {
	messageIndex int
	partIndex    int
	image        Image
	key          string
	contextText  string
}

// ReplaceImages replaces image blocks with descriptions keyed by ImageHash. A
// missing description is replaced with the explicit no-sidecar marker.
func ReplaceImages(req *shared.NormalizedRequest, descriptions map[string]string) (bool, error) {
	images, err := collectRequestImages(req, ValidationOptions{})
	if err != nil {
		return false, err
	}
	replacements := make(map[imageLocation]string, len(images))
	for _, item := range images {
		replacements[imageLocation{item.messageIndex, item.partIndex}] = descriptions[item.key]
	}
	return replaceRequestImages(req, replacements, NoSidecarReplacement)
}

type imageLocation struct {
	message int
	part    int
}

func replaceRequestImages(req *shared.NormalizedRequest, replacements map[imageLocation]string, fallback string) (bool, error) {
	if req == nil {
		return false, fmt.Errorf("replace images: nil request")
	}
	replaced := false
	for messageIndex := range req.Context.Messages {
		message := &req.Context.Messages[messageIndex]
		if !roleCarriesImages(message.Role) {
			continue
		}
		var parts []any
		if err := json.Unmarshal(message.Content, &parts); err != nil {
			var text string
			if json.Unmarshal(message.Content, &text) == nil {
				continue
			}
			return false, fmt.Errorf("decode %s message content: %w", message.Role, err)
		}
		changed := false
		for partIndex, rawPart := range parts {
			part, ok := rawPart.(map[string]any)
			if !ok || !isImageType(stringValue(part["type"])) {
				continue
			}
			description := strings.TrimSpace(replacements[imageLocation{messageIndex, partIndex}])
			text := fallback
			if description != "" {
				text = "[Image: " + clampDescription(description) + "]"
			}
			parts[partIndex] = map[string]any{"type": "text", "text": text}
			changed = true
			replaced = true
		}
		if changed {
			encoded, err := json.Marshal(parts)
			if err != nil {
				return false, fmt.Errorf("encode replaced %s message content: %w", message.Role, err)
			}
			message.Content = encoded
		}
	}
	return replaced, nil
}

func collectRequestImages(req *shared.NormalizedRequest, options ValidationOptions) ([]requestImage, error) {
	if req == nil {
		return nil, fmt.Errorf("collect images: nil request")
	}
	var images []requestImage
	for messageIndex, message := range req.Context.Messages {
		if !roleCarriesImages(message.Role) {
			continue
		}
		var parts []any
		if err := json.Unmarshal(message.Content, &parts); err != nil {
			var text string
			if json.Unmarshal(message.Content, &text) == nil {
				continue
			}
			return nil, fmt.Errorf("decode %s message content: %w", message.Role, err)
		}
		contextText := messageContext(parts)
		for partIndex, rawPart := range parts {
			part, ok := rawPart.(map[string]any)
			if !ok || !isImageType(stringValue(part["type"])) {
				continue
			}
			value, detail, err := imageReference(part)
			if err != nil {
				continue
			}
			image, err := ParseImage(value, options)
			if err != nil {
				continue
			}
			image.Detail = detail
			images = append(images, requestImage{
				messageIndex: messageIndex, partIndex: partIndex, image: image,
				key: imageIdentity(image), contextText: contextText,
			})
		}
	}
	return images, nil
}

func imageReference(part map[string]any) (string, string, error) {
	detail := stringValue(part["detail"])
	for _, name := range []string{"imageUrl", "image_url", "url"} {
		if value := stringValue(part[name]); value != "" {
			return value, detail, nil
		}
		if object, ok := part[name].(map[string]any); ok {
			if value := stringValue(object["url"]); value != "" {
				return value, firstNonEmpty(detail, stringValue(object["detail"])), nil
			}
		}
	}
	if source, ok := part["source"].(map[string]any); ok {
		switch stringValue(source["type"]) {
		case "base64":
			media := normalizeMIME(stringValue(source["media_type"]))
			data := stringValue(source["data"])
			if media != "" && data != "" {
				return "data:" + media + ";base64," + data, detail, nil
			}
		case "url":
			if value := stringValue(source["url"]); value != "" {
				return value, detail, nil
			}
		}
	}
	return "", detail, fmt.Errorf("image block has no supported source")
}

func messageContext(parts []any) string {
	var values []string
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}
		if part["type"] == "text" || part["type"] == "input_text" {
			if text := stringValue(part["text"]); text != "" {
				values = append(values, text)
			}
		}
	}
	return clampText(strings.Join(values, " "), 800)
}

func roleCarriesImages(role string) bool {
	return role == "user" || role == "developer" || role == "toolResult" || role == "tool"
}

func isImageType(value string) bool {
	return value == "image" || value == "input_image" || value == "image_url"
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func clampDescription(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= 2000 {
		return value
	}
	return string(runes[:2000]) + "\n…[description truncated]"
}
