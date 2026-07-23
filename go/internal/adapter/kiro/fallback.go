package kiro

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func AppendFallbackText(base, fallback string) string {
	if base == "" {
		return fallback
	}
	if fallback == "" {
		return base
	}
	return base + "\n\n" + fallback
}

func ToolCallFallbackText(call types.ToolCall) string {
	arguments := string(call.Arguments)
	if arguments == "" {
		arguments = "{}"
	}
	return fmt.Sprintf("Tool call fallback (%s, id %s):\n%s", call.Name, NormalizeToolID(call.ID), arguments)
}

func ToolResultFallbackText(message types.Message) string {
	status := "success"
	if message.IsError {
		status = "error"
	}
	content := contentText(message.Content, true)
	if content == "" {
		content = "(empty)"
	}
	return fmt.Sprintf("Tool result fallback (%s, id %s, %s):\n%s", message.ToolName, NormalizeToolID(message.ToolCallID), status, content)
}

func contentText(raw json.RawMessage, imageMarkers bool) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return string(raw)
	}
	if text, ok := value.(string); ok {
		return text
	}
	parts, _ := value.([]any)
	lines := make([]string, 0, len(parts))
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		typeName, _ := part["type"].(string)
		switch typeName {
		case "text", "input_text", "output_text":
			if text := firstString(part, "text", "input_text"); text != "" {
				lines = append(lines, text)
			}
		case "image", "input_image", "image_url":
			if imageMarkers {
				detail := firstString(part, "detail")
				if detail == "" {
					detail = "auto"
				}
				lines = append(lines, "[image:"+detail+"]")
			}
		}
	}
	return strings.Join(lines, "\n")
}

func firstString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if text, ok := value[key].(string); ok {
			return text
		}
	}
	return ""
}
