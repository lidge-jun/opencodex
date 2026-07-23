package google

import (
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func IsVertexTruncationReason(reason string) bool {
	return reason == "MAX_TOKENS" || reason == "MALFORMED_FUNCTION_CALL"
}

func VertexTruncationErrorMessage(reason string) string {
	suffix := ""
	if reason != "" {
		safe := config.RedactString(strings.TrimSpace(reason))
		if len(safe) > 160 {
			safe = safe[:160]
		}
		suffix = fmt.Sprintf(" (%s)", safe)
	}
	return "Vertex AI response truncated upstream before the turn completed" + suffix
}
