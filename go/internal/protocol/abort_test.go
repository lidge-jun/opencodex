package protocol

import (
	"context"
	"testing"
	"time"
)

func TestAbortControllerParentCancel(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	ac := NewAbortController(parent, time.Second, time.Second)
	defer ac.Cancel()
	cancel()
	waitContextDone(t, ac.Context(), 200*time.Millisecond)
	waitContextDone(t, ac.BodyContext(), 200*time.Millisecond)
}

func TestAbortControllerDeadlineAndIdle(t *testing.T) {
	deadline := NewAbortController(context.Background(), 25*time.Millisecond, time.Second)
	defer deadline.Cancel()
	waitContextDone(t, deadline.Context(), 300*time.Millisecond)

	idle := NewAbortController(context.Background(), time.Second, 30*time.Millisecond)
	defer idle.Cancel()
	time.Sleep(15 * time.Millisecond)
	idle.ResetIdle()
	select {
	case <-idle.Context().Done():
		t.Fatal("idle timeout fired before reset window elapsed")
	case <-time.After(20 * time.Millisecond):
	}
	waitContextDone(t, idle.Context(), 200*time.Millisecond)
}

func TestAbortControllerBodyCancellationIsSeparate(t *testing.T) {
	ac := NewAbortController(context.Background(), time.Second, time.Second)
	defer ac.Cancel()
	ac.CancelBody()
	waitContextDone(t, ac.BodyContext(), 100*time.Millisecond)
	select {
	case <-ac.Context().Done():
		t.Fatal("body cancellation canceled request context")
	default:
	}
}

func waitContextDone(t *testing.T, ctx context.Context, timeout time.Duration) {
	t.Helper()
	select {
	case <-ctx.Done():
	case <-time.After(timeout):
		t.Fatal("context was not canceled")
	}
}
