package kiro

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

type ErrorClassification struct {
	Message   string
	Status    int
	ErrorType string
	Code      string
	Retryable bool
}

var detailKeys = []string{"__type", "code", "error", "name", "reason", "message", "Message", "errorMessage"}

func ClassifyHTTPError(status int, headers http.Header, payload string) ErrorClassification {
	return classifyFailure(status, headerErrorType(headers), payload)
}

func ClassifyStreamError(headers map[string]string, payload string) ErrorClassification {
	return classifyFailure(0, firstNonEmpty(headers[":exception-type"], headers[":error-type"]), payload)
}

func ClassifyEventError(reason, message string) ErrorClassification {
	payload, _ := json.Marshal(map[string]string{"reason": config.RedactString(reason), "message": config.RedactString(message)})
	return classifyFailure(0, "", string(payload))
}

func SafeErrorMessage(headers map[string]string, payload string) string {
	return ClassifyStreamError(headers, payload).Message
}

func classifyFailure(status int, headerType, payload string) ErrorClassification {
	details := payloadDetails(payload)
	parts := append([]string{}, headerType)
	parts = append(parts, details...)
	detail := strings.Trim(strings.Join(nonEmpty(parts), ": "), " ")
	detail = config.RedactString(detail)
	if len(detail) > 500 {
		detail = detail[:500]
	}
	evidence := strings.ToLower(strings.Join([]string{headerType, detail}, " "))
	prefix := classifyPrefix(status, evidence)
	message := prefix
	if detail != "" {
		message += ": " + detail
	} else if status > 0 {
		message += fmt.Sprintf(": HTTP %d", status)
	}

	if strings.Contains(evidence, "content_length_exceeds_threshold") || strings.Contains(evidence, "content length exceeds") {
		return ErrorClassification{"Kiro rejected the request because the conversation exceeds the model's context window. Compact or reduce the history, or start a new session.", 400, "invalid_request_error", "context_length_exceeded", false}
	}
	if containsAny(evidence, "insufficient_quota", "quota exhausted", "quota exceeded") {
		return ErrorClassification{message, 429, "insufficient_quota", "insufficient_quota", false}
	}
	if status == 429 || containsAny(evidence, "throttlingexception", "too many requests", "rate limit") {
		return ErrorClassification{message, 429, "rate_limit_error", "rate_limit_exceeded", true}
	}
	if status == 401 || status == 403 || containsAny(evidence, "accessdenied", "access denied", "unauthorized", "unrecognizedclient", "expiredtoken", "expired token", "invalid token", "authentication") {
		if status == 403 {
			return ErrorClassification{message, 403, "permission_error", "permission_denied", false}
		}
		return ErrorClassification{message, 401, "authentication_error", "invalid_api_key", false}
	}
	if status == 400 || containsAny(evidence, "validationexception", "invalid request", "model unavailable", "model not found", "unsupported model", "profile arn", "malformed") {
		return ErrorClassification{message, 400, "invalid_request_error", "invalid_request_error", false}
	}
	if status == 503 || containsAny(evidence, "overloaded", "server is busy", "temporarily unavailable") {
		return ErrorClassification{message, 503, "server_error", "server_is_overloaded", true}
	}
	if status < 500 {
		status = 502
	}
	return ErrorClassification{message, status, "server_error", "upstream_server_error", true}
}

func classifyPrefix(status int, evidence string) string {
	if containsAny(evidence, "insufficient_quota", "quota exhausted", "account quota exceeded", "monthly quota exceeded", "daily quota exceeded", "exceeded your current quota") {
		return "Kiro quota exhausted"
	}
	if status == 429 || containsAny(evidence, "throttlingexception", "too many requests", "rate limited", "rate limit") {
		return "Kiro rate limit exceeded"
	}
	if status == 401 || status == 403 || containsAny(evidence, "accessdenied", "access denied", "unauthorized", "unrecognizedclient", "expiredtoken", "expired token", "invalid token", "authentication") {
		return "Kiro authentication failed"
	}
	if status == 503 || containsAny(evidence, "overloaded", "server is busy", "temporarily unavailable") {
		return "Kiro server overloaded"
	}
	if status == 400 || containsAny(evidence, "validationexception", "invalid request", "profile arn", "model unavailable", "model not found", "unsupported model", "region", "schema", "malformed") {
		return "Kiro invalid request"
	}
	return "Kiro upstream error"
}

func payloadDetails(payload string) []string {
	trimmed := strings.TrimSpace(payload)
	if trimmed == "" {
		return nil
	}
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
		return []string{trimmed}
	}
	var value any
	if json.Unmarshal([]byte(trimmed), &value) != nil {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		if text, ok := value.(string); ok {
			return []string{text}
		}
		return nil
	}
	out := make([]string, 0)
	for _, key := range detailKeys {
		if text, ok := object[key].(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, strings.TrimSpace(text))
		}
	}
	return out
}

func headerErrorType(headers http.Header) string {
	return firstNonEmpty(headers.Get(":exception-type"), headers.Get(":error-type"), headers.Get("x-amzn-errortype"))
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
func nonEmpty(values []string) []string {
	out := values[:0]
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			out = append(out, v)
		}
	}
	return out
}
func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
