package sidecar

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestShutdownTrackerAdmissionLatchAndAbort(t *testing.T) {
	tracker := NewShutdownTracker()
	lease, ok := tracker.Register(context.Background())
	if !ok || lease == nil {
		t.Fatal("initial turn was not admitted")
	}
	if tracker.Active() != 1 {
		t.Fatalf("active = %d, want 1", tracker.Active())
	}
	if !tracker.BeginShutdown() || !tracker.IsDraining() {
		t.Fatal("shutdown did not latch")
	}
	if tracker.BeginShutdown() {
		t.Fatal("second shutdown begin should be idempotent")
	}
	if rejected, admitted := tracker.Register(context.Background()); admitted || rejected != nil {
		t.Fatal("new turn admitted after shutdown")
	}

	var aborted atomic.Int32
	lease.OnAbort(func() { aborted.Add(1) })
	tracker.AbortAll()
	select {
	case <-lease.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("abort did not cancel turn context")
	}
	if aborted.Load() != 1 {
		t.Fatalf("abort callback count = %d, want 1", aborted.Load())
	}
	lease.Release()
	if tracker.Active() != 0 {
		t.Fatalf("active after release = %d, want 0", tracker.Active())
	}
	if err := tracker.Wait(context.Background()); err != nil {
		t.Fatalf("wait after release: %v", err)
	}
}

func TestShutdownTrackerWaitHonorsDeadlineThenReleases(t *testing.T) {
	tracker := NewShutdownTracker()
	lease, ok := tracker.Register(context.Background())
	if !ok {
		t.Fatal("turn was not admitted")
	}
	tracker.BeginShutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := tracker.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait error = %v, want deadline exceeded", err)
	}
	lease.Release()
	if err := tracker.Wait(context.Background()); err != nil {
		t.Fatalf("wait after release: %v", err)
	}
}

func TestParseShutdownTimeout(t *testing.T) {
	cases := []struct {
		raw  string
		want time.Duration
	}{
		{"", defaultShutdownTimeout},
		{"not-a-number", defaultShutdownTimeout},
		{"0", 0},
		{" 1250 ", 1250 * time.Millisecond},
		{"-1", 0},
	}
	for _, tc := range cases {
		if got := ParseShutdownTimeout(tc.raw); got != tc.want {
			t.Errorf("ParseShutdownTimeout(%q) = %s, want %s", tc.raw, got, tc.want)
		}
	}
}

func TestDrainAndShutdownAbortsAfterDeadline(t *testing.T) {
	tracker := NewShutdownTracker()
	lease, ok := tracker.Register(context.Background())
	if !ok {
		t.Fatal("turn was not admitted")
	}
	if DrainAndShutdown(context.Background(), tracker, 0) {
		t.Fatal("drain unexpectedly completed while turn was held")
	}
	select {
	case <-lease.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("deadline drain did not cancel the held turn")
	}
	lease.Release()
	if !tracker.IsDraining() || tracker.Active() != 0 {
		t.Fatalf("tracker state = draining=%v active=%d", tracker.IsDraining(), tracker.Active())
	}
}

func TestDataPlaneSeamRejectsAfterShutdownBegins(t *testing.T) {
	tracker := NewShutdownTracker()
	tracker.BeginShutdown()
	h := NewHandler(Config{
		RequestToken:    "request-token",
		BridgeToken:     "bridge-token",
		ShutdownTracker: tracker,
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	req.Header.Set(SidecarRequestHeader, "request-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Fatalf("Retry-After = %q, want 5", got)
	}
	if got, want := rec.Body.String(), `{"error":{"message":"Service shutting down","type":"server_error","code":"server_is_overloaded"}}`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestWebSocketBridgeRejectsUpgradeAfterShutdownBegins(t *testing.T) {
	tracker := NewShutdownTracker()
	tracker.BeginShutdown()
	h := NewHandler(Config{
		RequestToken:    "request-token",
		BridgeToken:     "bridge-token",
		ShutdownTracker: tracker,
	})
	req := httptest.NewRequest(http.MethodGet, ResponsesWSBridgePath, nil)
	req.Header.Set(SidecarRequestHeader, "request-token")
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Fatalf("Retry-After = %q, want 5", got)
	}
}
