package protocol

import (
	"sync/atomic"
	"testing"
	"time"
)

func TestStallWatcherInactivityTriggersOnce(t *testing.T) {
	fired := make(chan struct{}, 1)
	sw := NewStallWatcher(25*time.Millisecond, func() { fired <- struct{}{} })
	defer sw.Stop()
	select {
	case <-fired:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("stall callback did not fire")
	}
	sw.Activity()
	select {
	case <-fired:
		t.Fatal("stall callback fired more than once")
	case <-time.After(40 * time.Millisecond):
	}
}

func TestStallWatcherActivityAndStop(t *testing.T) {
	var calls atomic.Int32
	sw := NewStallWatcher(30*time.Millisecond, func() { calls.Add(1) })
	for range 3 {
		time.Sleep(15 * time.Millisecond)
		sw.Activity()
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("callback calls = %d before inactivity", got)
	}
	sw.Stop()
	time.Sleep(40 * time.Millisecond)
	if got := calls.Load(); got != 0 {
		t.Fatalf("callback calls = %d after Stop", got)
	}
}
