package openai

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestReadUpstreamHTTPErrorSanitizesPayload(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusBadRequest,
		Status:     "400 Bad Request",
		Body: io.NopCloser(strings.NewReader(
			`{"error":{"message":"Bearer abcdefghijklmnop failed at /Users/jun/private/key.txt"}}`,
		)),
	}
	err := ReadUpstreamHTTPError(context.Background(), response)
	var upstream *UpstreamHTTPError
	if !errors.As(err, &upstream) {
		t.Fatalf("error type = %T, want *UpstreamHTTPError", err)
	}
	if strings.Contains(upstream.Message, "abcdefghijklmnop") || strings.Contains(upstream.Message, "/Users/jun") {
		t.Fatalf("sanitizer leaked sensitive data: %q", upstream.Message)
	}
	if !strings.Contains(upstream.Message, "[REDACTED]") || !strings.Contains(upstream.Message, "[REDACTED_PATH]") {
		t.Fatalf("sanitizer markers missing: %q", upstream.Message)
	}
}

func TestReadUpstreamHTTPErrorDoesNotEchoHTML(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusBadGateway,
		Status:     "502 Bad Gateway",
		Body:       io.NopCloser(strings.NewReader("<html>private proxy page</html>")),
	}
	err := ReadUpstreamHTTPError(context.Background(), response).(*UpstreamHTTPError)
	if err.Message != "" || !err.Retryable {
		t.Fatalf("unexpected sanitized error: %#v", err)
	}
}
