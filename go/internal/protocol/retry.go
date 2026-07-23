package protocol

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// RetryPolicy controls replay-safe retries before a response is committed.
type RetryPolicy struct {
	MaxAttempts     int
	BaseDelay       time.Duration
	MaxDelay        time.Duration
	AttemptDeadline time.Duration
}

// HTTPStatusError allows callers of ShouldRetry to classify an HTTP failure.
type HTTPStatusError struct{ StatusCode int }

func (e *HTTPStatusError) Error() string { return http.StatusText(e.StatusCode) }

// CommittedError marks an error that occurred after request or response commitment.
type CommittedError interface {
	error
	Committed() bool
}

// ShouldRetry classifies err and computes a Retry-After or jittered backoff delay.
// attempt is zero-based and identifies the attempt that just failed.
func (p *RetryPolicy) ShouldRetry(attempt int, err error, headers http.Header) (bool, time.Duration) {
	if attempt+1 >= p.attempts() || !isRetryableError(err) {
		return false, 0
	}
	return true, p.delay(attempt, headers, time.Now())
}

// Do invokes fn until it succeeds, returns a non-transient response, or exhausts policy.
func (p *RetryPolicy) Do(ctx context.Context, fn func(ctx context.Context) (*http.Response, error)) (*http.Response, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	operationCtx := ctx
	cancel := func() {}
	if p.AttemptDeadline > 0 {
		operationCtx, cancel = context.WithTimeout(ctx, p.AttemptDeadline)
	}
	defer cancel()

	var lastErr error
	for attempt := 0; attempt < p.attempts(); attempt++ {
		if err := operationCtx.Err(); err != nil {
			return nil, err
		}
		res, err := fn(operationCtx)
		if err == nil && res == nil {
			return nil, fmt.Errorf("retry: attempt %d returned nil response without error", attempt+1)
		}
		if err == nil && !isTransientStatus(res.StatusCode) {
			return res, nil
		}

		headers := http.Header(nil)
		if res != nil {
			headers = res.Header
		}
		if err == nil {
			lastErr = &HTTPStatusError{StatusCode: res.StatusCode}
		} else {
			lastErr = err
		}
		retry, delay := p.ShouldRetry(attempt, lastErr, headers)
		if !retry {
			if res != nil {
				return res, err
			}
			return nil, err
		}
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if err := sleepContext(operationCtx, delay); err != nil {
			return nil, err
		}
	}
	return nil, lastErr
}

func (p *RetryPolicy) attempts() int {
	if p.MaxAttempts < 1 {
		return 1
	}
	return p.MaxAttempts
}

func (p *RetryPolicy) delay(attempt int, headers http.Header, now time.Time) time.Duration {
	maxDelay := p.MaxDelay
	if maxDelay <= 0 {
		maxDelay = 30 * time.Second
	}
	if delay, ok := parseRetryAfter(headers.Get("Retry-After"), now); ok {
		if delay > maxDelay {
			return maxDelay
		}
		return delay
	}
	base := p.BaseDelay
	if base <= 0 {
		base = 100 * time.Millisecond
	}
	exp := base
	for i := 0; i < attempt && exp < maxDelay; i++ {
		if exp > maxDelay/2 {
			exp = maxDelay
			break
		}
		exp *= 2
	}
	if exp > maxDelay {
		exp = maxDelay
	}
	return time.Duration(float64(exp) * (0.8 + rand.Float64()*0.4))
}

func parseRetryAfter(raw string, now time.Time) (time.Duration, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(raw, 64); err == nil {
		if seconds < 0 {
			seconds = 0
		}
		return time.Duration(seconds * float64(time.Second)), true
	}
	date, err := http.ParseTime(raw)
	if err != nil {
		return 0, false
	}
	if date.Before(now) {
		return 0, true
	}
	return date.Sub(now), true
}

func isRetryableError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var committed CommittedError
	if errors.As(err, &committed) && committed.Committed() {
		return false
	}
	var status *HTTPStatusError
	if errors.As(err, &status) {
		return isTransientStatus(status.StatusCode)
	}
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout() || netErr.Temporary()
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "connection reset by peer") ||
		strings.Contains(message, "socket connection was closed unexpectedly") ||
		errors.Is(err, io.ErrUnexpectedEOF)
}

func isTransientStatus(status int) bool {
	return status == 500 || status == 502 || status == 503 || status == 504 ||
		status == 520 || status == 521 || status == 522
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
