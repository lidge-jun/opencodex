package openai

import (
	"context"
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
