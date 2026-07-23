package kiro

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
)

const resetAttempts = 3

func IsConnectionReset(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "connection reset") || strings.Contains(message, "socket connection was closed unexpectedly")
}

func LegacyRuntimeURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	parts := strings.Split(parsed.Hostname(), ".")
	if len(parts) != 4 || parts[0] != "runtime" || parts[2] != "kiro" || parts[3] != "dev" {
		return ""
	}
	parsed.Host = "q." + parts[1] + ".amazonaws.com"
	return parsed.String()
}

func DoWithRetry(ctx context.Context, client *http.Client, request *http.Request) (*http.Response, error) {
	if client == nil {
		client = http.DefaultClient
	}
	policy := protocol.RetryPolicy{MaxAttempts: 3, BaseDelay: 150 * time.Millisecond, MaxDelay: time.Second}
	return policy.Do(ctx, func(attemptCtx context.Context) (*http.Response, error) {
		return doWithResetRecovery(attemptCtx, client, request)
	})
}

func doWithResetRecovery(ctx context.Context, client *http.Client, request *http.Request) (*http.Response, error) {
	var last error
	for attempt := 0; attempt < resetAttempts; attempt++ {
		clone := request.Clone(ctx)
		if request.GetBody != nil {
			body, err := request.GetBody()
			if err != nil {
				return nil, err
			}
			clone.Body = body
		}
		if attempt > 0 {
			clone.Close = true
			clone.Header.Set("Connection", "close")
		}
		response, err := client.Do(clone)
		if err == nil {
			return response, nil
		}
		last = err
		if !IsConnectionReset(err) || attempt == resetAttempts-1 {
			return nil, err
		}
		delay := 150 * time.Millisecond * time.Duration(1<<attempt)
		if delay > time.Second {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
	}
	return nil, last
}
