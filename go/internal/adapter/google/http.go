package google

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
)

const (
	DefaultGoogleRetryAttempts  = 3
	DefaultGoogleAttemptTimeout = 200 * time.Second
	googleErrorBodyLimit        = int64(64 << 10)
)

type RetryOptions struct {
	MaxAttempts    int
	AttemptTimeout time.Duration
	BaseDelay      time.Duration
	MaxDelay       time.Duration
	RawErrors      bool
}

// DoWithRetry executes a replay-safe Google-family request with bounded reset,
// transient retries, one INVALID_ARGUMENT compatibility repair, and final redaction.
func DoWithRetry(ctx context.Context, client *http.Client, request *http.Request, label string, options RetryOptions) (*http.Response, error) {
	if request == nil {
		return nil, fmt.Errorf("google retry: nil request")
	}
	if client == nil {
		client = http.DefaultClient
	}
	attempts := options.MaxAttempts
	if attempts <= 0 {
		attempts = DefaultGoogleRetryAttempts
	}
	timeout := options.AttemptTimeout
	if timeout <= 0 {
		timeout = DefaultGoogleAttemptTimeout
	}
	policy := protocol.RetryPolicy{MaxAttempts: attempts, BaseDelay: options.BaseDelay, MaxDelay: options.MaxDelay}
	activeBody, err := requestBodyBytes(request)
	if err != nil {
		return nil, err
	}
	compatibilityReplayUsed := false
	transientAttempt := 0
	for transientAttempt < attempts {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		attemptCtx, cancel := context.WithTimeout(ctx, timeout)
		attemptRequest := request.Clone(attemptCtx)
		if activeBody != nil {
			attemptRequest.Body = io.NopCloser(bytes.NewReader(activeBody))
			attemptRequest.ContentLength = int64(len(activeBody))
		}
		response, requestErr := client.Do(attemptRequest)
		if requestErr != nil {
			cancel()
			if errors.Is(requestErr, context.Canceled) && ctx.Err() != nil {
				return nil, ctx.Err()
			}
			// The per-attempt deadline is transient while the parent operation is still live.
			// RetryPolicy intentionally treats parent context deadlines as terminal, so use a
			// replay-safe transport sentinel only for computing this attempt's backoff.
			classifyErr := requestErr
			if errors.Is(requestErr, context.DeadlineExceeded) && ctx.Err() == nil {
				classifyErr = io.ErrUnexpectedEOF
			}
			retry, delay := policy.ShouldRetry(transientAttempt, classifyErr, nil)
			if !retry {
				return nil, requestErr
			}
			transientAttempt++
			if err := waitRetry(ctx, delay); err != nil {
				return nil, err
			}
			continue
		}

		if response.StatusCode == http.StatusBadRequest && !compatibilityReplayUsed && activeBody != nil {
			payload, readErr := readAndRestoreResponseBody(response)
			if readErr == nil {
				if repaired, ok := RepairGoogleInvalidRequestBody(string(activeBody), string(payload)); ok {
					compatibilityReplayUsed = true
					activeBody = []byte(repaired)
					_ = response.Body.Close()
					cancel()
					continue
				}
			}
		}

		if !RetryableGoogleStatus(response.StatusCode) {
			return finalizeGoogleResponse(response, label, options.RawErrors, cancel)
		}
		if response.StatusCode == http.StatusTooManyRequests && !options.RawErrors {
			payload, readErr := readAndRestoreResponseBody(response)
			if readErr == nil && IsQuotaExhaustedBody(string(payload)) {
				return finalizeGoogleResponse(response, label, false, cancel)
			}
		}
		retry, delay := policy.ShouldRetry(transientAttempt, &protocol.HTTPStatusError{StatusCode: response.StatusCode}, response.Header)
		if !retry {
			return finalizeGoogleResponse(response, label, options.RawErrors, cancel)
		}
		transientAttempt++
		_ = response.Body.Close()
		cancel()
		if err := waitRetry(ctx, delay); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("%s fetch failed", label)
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
	once   sync.Once
}

func (body *cancelReadCloser) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(body.cancel)
	return err
}

func finalizeGoogleResponse(response *http.Response, label string, raw bool, cancel context.CancelFunc) (*http.Response, error) {
	if response == nil {
		cancel()
		return nil, fmt.Errorf("%s fetch returned nil response", label)
	}
	if response.StatusCode >= 400 && !raw {
		normalized, err := normalizeGoogleErrorResponse(response, label, false)
		cancel()
		return normalized, err
	}
	if response.Body == nil {
		cancel()
		return response, nil
	}
	response.Body = &cancelReadCloser{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

func requestBodyBytes(request *http.Request) ([]byte, error) {
	if request.Body == nil {
		return nil, nil
	}
	if request.GetBody != nil {
		body, err := request.GetBody()
		if err != nil {
			return nil, fmt.Errorf("google retry: reset request body: %w", err)
		}
		defer body.Close()
		data, err := io.ReadAll(body)
		return data, err
	}
	data, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, fmt.Errorf("google retry: read request body: %w", err)
	}
	request.Body = io.NopCloser(bytes.NewReader(data))
	return data, nil
}

func readAndRestoreResponseBody(response *http.Response) ([]byte, error) {
	if response == nil || response.Body == nil {
		return nil, fmt.Errorf("nil response body")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, googleErrorBodyLimit+1))
	_ = response.Body.Close()
	if len(payload) > int(googleErrorBodyLimit) {
		payload = payload[:googleErrorBodyLimit]
	}
	response.Body = io.NopCloser(bytes.NewReader(payload))
	response.ContentLength = int64(len(payload))
	return payload, err
}

func normalizeGoogleErrorResponse(response *http.Response, label string, raw bool) (*http.Response, error) {
	if response == nil || response.StatusCode < 400 || raw {
		return response, nil
	}
	payload, _ := readAndRestoreResponseBody(response)
	message := SafeGoogleHTTPErrorMessage(label, response.StatusCode, string(payload))
	body, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": "provider_error"}})
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Type", "application/json")
	return response, nil
}

func waitRetry(ctx context.Context, delay time.Duration) error {
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
