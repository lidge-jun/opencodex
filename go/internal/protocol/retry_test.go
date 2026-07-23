package protocol

import (
	"context"
	"errors"
	"io"
	"net/http"
	"syscall"
	"testing"
	"time"
)

func TestRetryPolicyTransientThenSuccess(t *testing.T) {
	policy := RetryPolicy{MaxAttempts: 3, BaseDelay: time.Millisecond, MaxDelay: 2 * time.Millisecond, AttemptDeadline: time.Second}
	attempts := 0
	res, err := policy.Do(context.Background(), func(context.Context) (*http.Response, error) {
		attempts++
		if attempts == 1 {
			return nil, syscall.ECONNRESET
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(nilReader{})}, nil
	})
	if err != nil || res.StatusCode != http.StatusOK || attempts != 2 {
		t.Fatalf("Do() = %#v, %v after %d attempts", res, err, attempts)
	}
}

func TestRetryPolicyMaxAttemptsAndNonRetryable(t *testing.T) {
	policy := RetryPolicy{MaxAttempts: 2, BaseDelay: time.Millisecond, MaxDelay: time.Millisecond}
	attempts := 0
	_, err := policy.Do(context.Background(), func(context.Context) (*http.Response, error) {
		attempts++
		return nil, syscall.ECONNRESET
	})
	if !errors.Is(err, syscall.ECONNRESET) || attempts != 2 {
		t.Fatalf("error = %v, attempts = %d", err, attempts)
	}

	attempts = 0
	want := errors.New("invalid request")
	_, err = policy.Do(context.Background(), func(context.Context) (*http.Response, error) {
		attempts++
		return nil, want
	})
	if !errors.Is(err, want) || attempts != 1 {
		t.Fatalf("non-retry error = %v, attempts = %d", err, attempts)
	}
}

func TestRetryAfterSecondsAndHTTPDate(t *testing.T) {
	policy := RetryPolicy{MaxAttempts: 2, MaxDelay: 10 * time.Second}
	ok, delay := policy.ShouldRetry(0, &HTTPStatusError{StatusCode: 503}, http.Header{"Retry-After": {"2"}})
	if !ok || delay != 2*time.Second {
		t.Fatalf("seconds retry = %v, %v", ok, delay)
	}
	date := time.Now().Add(3 * time.Second).UTC().Format(http.TimeFormat)
	ok, delay = policy.ShouldRetry(0, &HTTPStatusError{StatusCode: 503}, http.Header{"Retry-After": {date}})
	if !ok || delay < time.Second || delay > 3*time.Second {
		t.Fatalf("date retry = %v, %v", ok, delay)
	}
}

func TestRetryPolicyDeadlineExceeded(t *testing.T) {
	policy := RetryPolicy{MaxAttempts: 3, BaseDelay: 100 * time.Millisecond, AttemptDeadline: 20 * time.Millisecond}
	attempts := 0
	_, err := policy.Do(context.Background(), func(context.Context) (*http.Response, error) {
		attempts++
		return nil, syscall.ECONNRESET
	})
	if !errors.Is(err, context.DeadlineExceeded) || attempts != 1 {
		t.Fatalf("error = %v, attempts = %d", err, attempts)
	}
}

type nilReader struct{}

func (nilReader) Read([]byte) (int, error) { return 0, io.EOF }
