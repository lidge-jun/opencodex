package bridge

import (
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func eventTypes(events []Event) []string {
	out := make([]string, len(events))
	for i := range events {
		out[i] = events[i].Type
	}
	return out
}

func TestConvertOrdersMessageLifecycle(t *testing.T) {
	events, response := Convert("model", []types.AdapterEvent{{Type: types.EventTextDelta, Text: "hello"}, {Type: types.EventDone}})
	want := []string{"response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"}
	got := eventTypes(events)
	if len(got) != len(want) {
		t.Fatalf("event count = %d, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("event[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if response.Status != "completed" || len(response.Output) != 1 {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestConvertAccumulatesToolArguments(t *testing.T) {
	call := func(args string) *types.ToolCall {
		return &types.ToolCall{ID: "call_1", Name: "shell", Arguments: json.RawMessage(args)}
	}
	_, response := Convert("model", []types.AdapterEvent{{Type: types.EventToolCall, ToolCall: call(`{"cmd":"`)}, {Type: types.EventToolCall, ToolCall: call(`pwd"}`)}, {Type: types.EventDone}})
	if got := response.Output[0]["arguments"]; got != `{"cmd":"pwd"}` {
		t.Fatalf("arguments = %q", got)
	}
}

func TestConvertIgnoresEventsAfterTerminal(t *testing.T) {
	events, response := Convert("model", []types.AdapterEvent{{Type: types.EventError, Error: "boom"}, {Type: types.EventDone}, {Type: types.EventTextDelta, Text: "late"}})
	if response.Status != "failed" {
		t.Fatalf("status = %q", response.Status)
	}
	terminals := 0
	for _, event := range events {
		if event.Type == "response.failed" || event.Type == "response.completed" {
			terminals++
		}
	}
	if terminals != 1 {
		t.Fatalf("terminal count = %d", terminals)
	}
}
