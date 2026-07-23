package types

import (
	"errors"
	"testing"
)

func TestTypedErrorAssertions(t *testing.T) {
	cause := errors.New("credential rejected")
	err := NewAuthError("authentication failed", cause)
	var authErr *AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("errors.As(%T) failed", err)
	}
	if !errors.Is(err, cause) {
		t.Fatal("typed error did not preserve its cause")
	}
	if authErr.StatusCode != 401 || authErr.Code != "invalid_api_key" {
		t.Fatalf("unexpected auth error: %#v", authErr)
	}

	rateErr := NewRateLimitError("slow down", &RetryMeta{Attempt: 1})
	var typedRate *RateLimitError
	if !errors.As(rateErr, &typedRate) || !typedRate.Retryable || typedRate.StatusCode != 429 {
		t.Fatalf("unexpected rate limit error: %#v", rateErr)
	}
}
