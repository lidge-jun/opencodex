package kiro

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

var truncationPattern = regexp.MustCompile(`(?i)length|max[_-]?tokens?|truncat|incomplete|context_length`)
var reasonKeys = []string{"finish_reason", "finishReason", "stop_reason", "stopReason", "completionReason", "reason"}

func TruncationReason(parsed map[string]any) string {
	if truncated, _ := parsed["truncated"].(bool); truncated {
		return "truncated"
	}
	for _, key := range reasonKeys {
		if value, ok := parsed[key].(string); ok && truncationPattern.MatchString(strings.TrimSpace(value)) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func IsCompleteToolInput(input string) bool {
	if strings.TrimSpace(input) == "" {
		return true
	}
	var value any
	if json.Unmarshal([]byte(input), &value) != nil || value == nil {
		return false
	}
	switch value.(type) {
	case map[string]any, []any:
		return true
	default:
		return false
	}
}

func TruncationErrorMessage(reason string) string {
	if reason == "" {
		return "Kiro response truncated upstream before the tool call completed"
	}
	safe := config.RedactString(reason)
	if len(safe) > 160 {
		safe = safe[:160]
	}
	return "Kiro response truncated upstream before the tool call completed (" + safe + ")"
}
