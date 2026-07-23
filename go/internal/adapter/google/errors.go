package google

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

const maxGoogleErrorDetail = 500

type googleErrorEnvelope struct {
	Error struct {
		Message any `json:"message"`
		Status  any `json:"status"`
	} `json:"error"`
}

// SafeGoogleHTTPErrorMessage returns a bounded, classified, secret-redacted error.
func SafeGoogleHTTPErrorMessage(label string, status int, payloadText string) string {
	message, enumStatus := googleErrorDetail(payloadText)
	prefix := classifyGoogleError(label, status, enumStatus, message+" "+enumStatus)
	detail := fmt.Sprintf("HTTP %d", status)
	if message != "" {
		detail = config.RedactString(strings.Map(func(r rune) rune {
			if r < 0x20 && r != '\t' {
				return ' '
			}
			return r
		}, message))
		if len(detail) > maxGoogleErrorDetail {
			detail = detail[:maxGoogleErrorDetail]
		}
	}
	return prefix + ": " + detail
}

func SafeVertexHTTPErrorMessage(status int, payloadText string) string {
	return SafeGoogleHTTPErrorMessage("Vertex AI", status, payloadText)
}

func SafeAntigravityHTTPErrorMessage(status int, payloadText string) string {
	return SafeGoogleHTTPErrorMessage("Antigravity", status, payloadText)
}

func RetryableGoogleStatus(status int) bool {
	return status == 429 || status == 500 || status == 502 || status == 503 || status == 504
}

func IsQuotaExhaustedBody(payloadText string) bool {
	message, status := googleErrorDetail(payloadText)
	if status != "RESOURCE_EXHAUSTED" {
		return false
	}
	lower := strings.ToLower(message)
	return strings.Contains(lower, "quotafailure") || strings.Contains(lower, "quota exceeded") ||
		strings.Contains(lower, "exceeded your current quota") || strings.Contains(lower, "billing")
}

func googleErrorDetail(payloadText string) (message, status string) {
	trimmed := strings.TrimSpace(payloadText)
	if trimmed == "" {
		return "", ""
	}
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
		return trimmed, ""
	}
	var envelope googleErrorEnvelope
	if json.Unmarshal([]byte(trimmed), &envelope) != nil {
		return "", ""
	}
	return safeErrorString(envelope.Error.Message), safeErrorString(envelope.Error.Status)
}

func safeErrorString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64, bool:
		return fmt.Sprint(typed)
	default:
		return ""
	}
}

func classifyGoogleError(label string, status int, enumStatus, text string) string {
	lower := strings.ToLower(enumStatus + " " + text)
	quota := strings.Contains(lower, "quotafailure") || strings.Contains(lower, "quota exceeded") ||
		strings.Contains(lower, "exceeded your current quota") || strings.Contains(lower, "billing")
	switch {
	case enumStatus == "RESOURCE_EXHAUSTED" && quota:
		return label + " quota exhausted"
	case status == 429 || enumStatus == "RESOURCE_EXHAUSTED" || strings.Contains(lower, "rate limit"):
		return label + " rate limit exceeded"
	case status == 401 || enumStatus == "UNAUTHENTICATED" || strings.Contains(lower, "unauthenticated") ||
		strings.Contains(lower, "invalid authentication") || strings.Contains(lower, "expired"):
		return label + " authentication failed"
	case status == 403 || enumStatus == "PERMISSION_DENIED" || strings.Contains(lower, "permission denied") || strings.Contains(lower, "access denied"):
		return label + " access denied"
	case status == 503 || enumStatus == "UNAVAILABLE" || strings.Contains(lower, "overloaded") || strings.Contains(lower, "unavailable"):
		return label + " server overloaded"
	case status == 400 || status == 404 || enumStatus == "INVALID_ARGUMENT" || enumStatus == "NOT_FOUND" ||
		strings.Contains(lower, "invalid") || strings.Contains(lower, "not found") || strings.Contains(lower, "malformed"):
		return label + " invalid request"
	default:
		return label + " upstream error"
	}
}
