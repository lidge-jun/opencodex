package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

var absolutePathPattern = regexp.MustCompile(`(?:/Users/[^ "';,]+|/home/[^ "';,]+|/root/[^ "';,]*|[A-Za-z]:\\Users\\[^ "';,]+)`)

type UpstreamHTTPError struct {
	StatusCode int
	Status     string
	Message    string
	Retryable  bool
}

func (e *UpstreamHTTPError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("upstream HTTP error: %s", e.Status)
	}
	return fmt.Sprintf("upstream HTTP error: %s: %s", e.Status, e.Message)
}

func SanitizeUpstreamErrorText(value string) string {
	return absolutePathPattern.ReplaceAllString(config.RedactString(value), "[REDACTED_PATH]")
}

func SafeUpstreamErrorString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func ParseUpstreamJSONPayload(payload []byte) (any, bool) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" || (trimmed[0] != '{' && trimmed[0] != '[') {
		return nil, false
	}
	var parsed any
	if json.Unmarshal([]byte(trimmed), &parsed) != nil {
		return nil, false
	}
	return parsed, true
}

func ReadUpstreamHTTPError(ctx context.Context, response *http.Response) error {
	if response == nil {
		return errors.New("upstream HTTP error: nil response")
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	var payload []byte
	if response.Body != nil {
		defer response.Body.Close()
		payload, _ = ReadBodyBounded(ctx, response.Body, DefaultErrorBodyLimit)
	}
	message := extractUpstreamMessage(payload)
	return &UpstreamHTTPError{
		StatusCode: response.StatusCode,
		Status:     response.Status,
		Message:    SanitizeUpstreamErrorText(message),
		Retryable:  response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500,
	}
}

func extractUpstreamMessage(payload []byte) string {
	parsed, ok := ParseUpstreamJSONPayload(payload)
	if !ok {
		return ""
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return ""
	}
	if message := SafeUpstreamErrorString(obj["message"]); message != "" {
		return message
	}
	if message := SafeUpstreamErrorString(obj["title"]); message != "" {
		return message
	}
	if errObj, ok := obj["error"].(map[string]any); ok {
		return SafeUpstreamErrorString(errObj["message"])
	}
	if message := SafeUpstreamErrorString(obj["error"]); message != "" {
		return message
	}
	return SafeUpstreamErrorString(obj["detail"])
}

func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, DefaultErrorBodyLimit))
	_ = body.Close()
}
