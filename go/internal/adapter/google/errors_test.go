package google

import (
	"strings"
	"testing"
)

func TestGoogleErrorClassificationRedactsSecretsAndQuota(t *testing.T) {
	payload := `{"error":{"status":"RESOURCE_EXHAUSTED","message":"QuotaFailure: billing apiKey=secret-value"}}`
	message := SafeVertexHTTPErrorMessage(429, payload)
	if !strings.Contains(message, "Vertex AI quota exhausted") || strings.Contains(message, "secret-value") || !strings.Contains(message, "[REDACTED]") {
		t.Fatalf("safe message = %q", message)
	}
	if !IsQuotaExhaustedBody(payload) {
		t.Fatal("hard quota was not classified")
	}
	if IsQuotaExhaustedBody(`{"error":{"status":"RESOURCE_EXHAUSTED","message":"rate limit"}}`) {
		t.Fatal("transient rate limit was classified as hard quota")
	}
}

func TestGoogleStatusAndTruncationClassifiers(t *testing.T) {
	for _, status := range []int{429, 500, 502, 503, 504} {
		if !RetryableGoogleStatus(status) {
			t.Fatalf("status %d should retry", status)
		}
	}
	if RetryableGoogleStatus(400) || !IsVertexTruncationReason("MAX_TOKENS") || IsVertexTruncationReason("STOP") {
		t.Fatal("classifier mismatch")
	}
}
