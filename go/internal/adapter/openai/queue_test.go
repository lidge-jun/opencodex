package openai

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestTurnQueuePreservesOrdering(t *testing.T) {
	queue := NewTurnQueue(0)
	want := []string{"first", "second", "third"}
	for _, text := range want {
		if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: text}) {
			t.Fatalf("Push(%q) failed", text)
		}
	}
	queue.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	events, err := queue.Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != len(want) {
		t.Fatalf("got %d events, want %d", len(events), len(want))
	}
	for i := range want {
		if events[i].Text != want[i] {
			t.Fatalf("event %d = %q, want %q", i, events[i].Text, want[i])
		}
	}
	if queue.Push(types.AdapterEvent{Type: types.EventDone}) {
		t.Fatal("Push succeeded after Close")
	}
}

func TestTurnQueueBacklogExceeded(t *testing.T) {
	queue := NewTurnQueue(2)
	if queue.MaxBacklog != 1024 {
		t.Fatalf("default MaxBacklog = %d, want 1024", queue.MaxBacklog)
	}
	queue.MaxBacklog = 2
	var callbacks atomic.Int32
	queue.OnBacklogExceeded = func() { callbacks.Add(1) }

	if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: "first"}) {
		t.Fatal("first Push failed")
	}
	if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: "second"}) {
		t.Fatal("second Push failed")
	}
	if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: "overflow"}) {
		t.Fatal("overflow Push failed")
	}
	if got := callbacks.Load(); got != 1 {
		t.Fatalf("OnBacklogExceeded calls = %d, want 1", got)
	}
	if queue.Push(types.AdapterEvent{Type: types.EventDone}) {
		t.Fatal("Push succeeded after backlog closed the queue")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	events, err := queue.Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3: %#v", len(events), events)
	}
	if events[2].Type != types.EventError || events[2].Error != "consumer backlog exceeded — turn aborted" {
		t.Fatalf("terminal event = %#v", events[2])
	}
}

func TestTurnQueueDirectHandoffDoesNotCountAsBacklog(t *testing.T) {
	queue := NewTurnQueue(0)
	queue.MaxBacklog = 1
	var callbacks atomic.Int32
	queue.OnBacklogExceeded = func() { callbacks.Add(1) }
	received := make(chan types.AdapterEvent, 1)
	ready := make(chan struct{})
	go func() {
		close(ready)
		received <- <-queue.Stream()
	}()
	<-ready

	if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: "direct"}) {
		t.Fatal("direct Push failed")
	}
	select {
	case event := <-received:
		if event.Text != "direct" {
			t.Fatalf("received %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("waiting reader did not receive direct handoff")
	}
	if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: "queued"}) {
		t.Fatal("queued Push failed")
	}
	if got := callbacks.Load(); got != 0 {
		t.Fatalf("OnBacklogExceeded calls after one queued event = %d, want 0", got)
	}
	if !queue.Push(types.AdapterEvent{Type: types.EventTextDelta, Text: "overflow"}) {
		t.Fatal("overflow Push failed")
	}
	if got := callbacks.Load(); got != 1 {
		t.Fatalf("OnBacklogExceeded calls = %d, want 1", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := queue.Collect(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightAdapterEventsSkipsHeartbeat(t *testing.T) {
	source := make(chan types.AdapterEvent, 2)
	source <- types.AdapterEvent{Type: types.EventHeartbeat}
	source <- types.AdapterEvent{Type: types.EventError, Error: "upstream failed"}
	close(source)

	preflight := PreflightAdapterEvents(context.Background(), source)
	if preflight.Empty {
		t.Fatal("preflight reported empty after a non-heartbeat event")
	}
	if preflight.Error == nil || preflight.Error.Error != "upstream failed" {
		t.Fatalf("preflight error = %#v", preflight.Error)
	}
	events := collectEvents(preflight.Stream)
	if len(events) != 2 || events[0].Type != types.EventHeartbeat || events[1].Type != types.EventError {
		t.Fatalf("replayed events = %#v", events)
	}
}
