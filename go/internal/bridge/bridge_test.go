package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type recordingUsageRecorder struct {
	record *types.UsageRecord
}

func (r *recordingUsageRecorder) Record(_ context.Context, record *types.UsageRecord) error {
	copy := *record
	r.record = &copy
	return nil
}

func responseEvents(t *testing.T, stream string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, frame := range strings.Split(stream, "\n\n") {
		for _, line := range strings.Split(frame, "\n") {
			if !strings.HasPrefix(line, "data: ") || line == "data: [DONE]" {
				continue
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
				t.Fatalf("decode SSE event: %v", err)
			}
			events = append(events, event)
		}
	}
	return events
}

func terminalFrames(t *testing.T, stream string) []map[string]any {
	t.Helper()
	var terminals []map[string]any
	for _, event := range responseEvents(t, stream) {
		typeName, _ := event["type"].(string)
		if typeName == "response.completed" || typeName == "response.failed" || typeName == "response.incomplete" {
			terminals = append(terminals, event)
		}
	}
	return terminals
}

func incompleteReason(t *testing.T, terminal map[string]any) string {
	t.Helper()
	response, ok := terminal["response"].(map[string]any)
	if !ok {
		t.Fatalf("terminal response missing: %#v", terminal)
	}
	details, ok := response["incomplete_details"].(map[string]any)
	if !ok {
		t.Fatalf("incomplete_details missing: %#v", response)
	}
	reason, _ := details["reason"].(string)
	return reason
}

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

func TestStreamAdapterEOFFinishesIncomplete(t *testing.T) {
	events := make(chan types.AdapterEvent, 1)
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "partial"}
	close(events)

	var stream bytes.Buffer
	if err := StreamWithOptions(context.Background(), &stream, "model", events, StreamOptions{StallTimeout: time.Second}); err != nil {
		t.Fatal(err)
	}
	terminals := terminalFrames(t, stream.String())
	if len(terminals) != 1 || incompleteReason(t, terminals[0]) != "adapter_eof" {
		t.Fatalf("terminal frames = %#v", terminals)
	}
	if got := strings.Count(stream.String(), "data: [DONE]\n\n"); got != 1 {
		t.Fatalf("[DONE] count = %d, want 1", got)
	}
}

func TestStreamStallFinishesIncompleteAndCancels(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	events := make(chan types.AdapterEvent, 1)
	events <- types.AdapterEvent{Type: types.EventUsage, Usage: &types.Usage{InputTokens: 3, OutputTokens: 2}}
	cancelled := make(chan struct{}, 1)
	recorder := &recordingUsageRecorder{}
	record := &types.UsageRecord{StartedAt: time.Now()}

	var stream bytes.Buffer
	err := StreamWithOptions(ctx, &stream, "model", events, StreamOptions{
		StallTimeout: 10 * time.Millisecond,
		OnCancel: func() {
			cancel(UpstreamStallError)
			cancelled <- struct{}{}
		},
		Recorder: recorder,
		Record:   record,
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	default:
		t.Fatal("OnCancel was not invoked")
	}
	terminals := terminalFrames(t, stream.String())
	if len(terminals) != 1 || incompleteReason(t, terminals[0]) != "upstream_stall_timeout" {
		t.Fatalf("terminal frames = %#v", terminals)
	}
	if got := strings.Count(stream.String(), "data: [DONE]\n\n"); got != 1 {
		t.Fatalf("[DONE] count = %d, want 1", got)
	}
	if recorder.record == nil || recorder.record.Status != types.OutcomeProviderError {
		t.Fatalf("recorded usage = %#v, want provider error", recorder.record)
	}
}

func TestStreamHeartbeatResetsStallTimeout(t *testing.T) {
	events := make(chan types.AdapterEvent)
	go func() {
		defer close(events)
		<-time.After(30 * time.Millisecond)
		events <- types.AdapterEvent{Type: types.EventHeartbeat}
		<-time.After(30 * time.Millisecond)
		events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "alive"}
		events <- types.AdapterEvent{Type: types.EventDone}
	}()

	var stream bytes.Buffer
	if err := StreamWithOptions(context.Background(), &stream, "model", events, StreamOptions{StallTimeout: 50 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	terminals := terminalFrames(t, stream.String())
	if len(terminals) != 1 || terminals[0]["type"] != "response.completed" {
		t.Fatalf("terminal frames = %#v", terminals)
	}
	if strings.Contains(stream.String(), "response.incomplete") {
		t.Fatalf("heartbeat did not prevent stall: %s", stream.String())
	}
}

func TestStreamRecordsCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	events := make(chan types.AdapterEvent)
	usageAccepted := make(chan struct{})
	go func() {
		events <- types.AdapterEvent{Type: types.EventUsage, Usage: &types.Usage{InputTokens: 1}}
		close(usageAccepted)
	}()
	go func() {
		<-usageAccepted
		cancel()
	}()
	recorder := &recordingUsageRecorder{}

	var stream bytes.Buffer
	if err := StreamWithOptions(ctx, &stream, "model", events, StreamOptions{Recorder: recorder, Record: &types.UsageRecord{StartedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	if recorder.record == nil || recorder.record.Status != types.OutcomeCancelled {
		t.Fatalf("recorded usage = %#v, want cancelled", recorder.record)
	}
}

func TestStreamEmitsExactlyOneTerminal(t *testing.T) {
	tests := []struct {
		name  string
		first types.AdapterEvent
		want  string
	}{
		{name: "completed", first: types.AdapterEvent{Type: types.EventDone}, want: "response.completed"},
		{name: "failed", first: types.AdapterEvent{Type: types.EventError, Error: "boom"}, want: "response.failed"},
		{name: "incomplete", first: types.AdapterEvent{Type: types.EventIncomplete, Reason: "content_filter"}, want: "response.incomplete"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := make(chan types.AdapterEvent, 2)
			events <- test.first
			events <- types.AdapterEvent{Type: types.EventDone}
			close(events)

			var stream bytes.Buffer
			if err := Stream(context.Background(), &stream, "model", events); err != nil {
				t.Fatal(err)
			}
			terminals := terminalFrames(t, stream.String())
			if len(terminals) != 1 || terminals[0]["type"] != test.want {
				t.Fatalf("terminal frames = %#v, want one %s", terminals, test.want)
			}
			if got := strings.Count(stream.String(), "data: [DONE]\n\n"); got != 1 {
				t.Fatalf("[DONE] count = %d, want 1", got)
			}
		})
	}
}

func TestBufferedTreatsIncompleteAsTerminal(t *testing.T) {
	events := make(chan types.AdapterEvent, 2)
	events <- types.AdapterEvent{Type: types.EventIncomplete, Reason: "max_output_tokens", Message: "limit reached"}
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "late"}

	response, err := Buffered(context.Background(), "model", events)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "incomplete" || response.IncompleteDetails["reason"] != "max_output_tokens" || response.IncompleteDetails["message"] != "limit reached" {
		t.Fatalf("unexpected response: %#v", response)
	}
}
