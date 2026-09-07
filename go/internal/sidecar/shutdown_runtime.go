package sidecar

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultShutdownTimeout = 5 * time.Second
	ShutdownTimeoutEnv     = "OCX_SIDECAR_SHUTDOWN_TIMEOUT_MS"
)

// ParseShutdownTimeout reads the parent-provided millisecond budget. An absent
// or invalid value falls back to the TypeScript default of 5s; zero is a valid
// explicit immediate-drain budget and negative values clamp to zero.
func ParseShutdownTimeout(raw string) time.Duration {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultShutdownTimeout
	}
	value, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return defaultShutdownTimeout
	}
	if value < 0 {
		return 0
	}
	return time.Duration(value) * time.Millisecond
}

// DrainAndShutdown closes admission, waits for active handlers up to one
// absolute deadline, then cancels remaining turns. The caller must still call
// http.Server.Shutdown afterward; this split lets tests and the command keep
// listener closure separate from turn cancellation.
func DrainAndShutdown(ctx context.Context, tracker *ShutdownTracker, timeout time.Duration) bool {
	if tracker == nil {
		return true
	}
	if timeout < 0 {
		timeout = 0
	}
	tracker.BeginShutdown()
	deadlineCtx, cancel := context.WithTimeout(ctxOrBackground(ctx), timeout)
	defer cancel()
	if err := tracker.Wait(deadlineCtx); err == nil {
		return true
	} else if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		return false
	}
	tracker.AbortAll()
	return false
}

func ctxOrBackground(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

// ShutdownServer drains turns against one absolute budget, then asks net/http
// to close idle and active connections. A server shutdown timeout is bounded
// by the same remaining deadline, never a second independent grace period.
func ShutdownServer(server *http.Server, tracker *ShutdownTracker, timeout time.Duration) error {
	if server == nil {
		return nil
	}
	if tracker == nil {
		if timeout < 0 {
			timeout = 0
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return server.Shutdown(ctx)
	}
	if timeout < 0 {
		timeout = 0
	}
	deadline := time.Now().Add(timeout)
	tracker.BeginShutdown()
	waitCtx, cancelWait := context.WithDeadline(context.Background(), deadline)
	defer cancelWait()
	if err := tracker.Wait(waitCtx); err != nil {
		tracker.AbortAll()
	}
	remaining := time.Until(deadline)
	if remaining < 0 {
		remaining = 0
	}
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), remaining)
	defer cancelShutdown()
	return server.Shutdown(shutdownCtx)
}
