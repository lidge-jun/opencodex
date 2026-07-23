package chat

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestBuildChatCompletionIncludesReasoningToolCallsAndUsage(t *testing.T) {
	events := []types.AdapterEvent{
		{Type: types.EventReasoning, Reasoning: "think"},
		{Type: types.EventTextDelta, Text: "answer"},
		{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "call_1", Name: "lookup", Arguments: json.RawMessage(`{"q":"x"}`)}},
		{Type: types.EventDone, Usage: &types.Usage{InputTokens: 10, OutputTokens: 4, CachedInputTokens: 3, ReasoningOutputTokens: 2}},
	}
	body, err := BuildChatCompletion(events, "requested-model")
	if err != nil {
		t.Fatal(err)
	}
	choices := body["choices"].([]any)
	choice := choices[0].(map[string]any)
	message := choice["message"].(map[string]any)
	if choice["finish_reason"] != "tool_calls" || message["content"] != "answer" || message["reasoning_content"] != "think" {
		t.Fatalf("completion = %#v", body)
	}
	calls := message["tool_calls"].([]map[string]any)
	function := calls[0]["function"].(map[string]any)
	if function["name"] != "lookup" || function["arguments"] != `{"q":"x"}` {
		t.Fatalf("calls = %#v", calls)
	}
	usage := body["usage"].(map[string]any)
	if usage["total_tokens"] != 14 {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestWriteChatStreamEmitsStableToolIndicesFinishUsageAndDone(t *testing.T) {
	events := make(chan types.AdapterEvent, 4)
	events <- types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "call_1", Name: "lookup", Arguments: json.RawMessage(`{"q":"x"}`)}}
	events <- types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "call_2", Name: "read", Arguments: json.RawMessage(`{"path":"a"}`)}}
	events <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}
	close(events)
	w := httptest.NewRecorder()
	if err := WriteChatStream(context.Background(), w, "m", events); err != nil {
		t.Fatal(err)
	}
	body := w.Body.String()
	for _, want := range []string{`"role":"assistant"`, `"tool_calls"`, `"index":0`, `"index":1`, `"finish_reason":"tool_calls"`, `"total_tokens":3`, "data: [DONE]"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in %s", want, body)
		}
	}
}

func TestBuildAnthropicMessageUsesCacheExclusiveInput(t *testing.T) {
	body, err := buildAnthropicMessage([]types.AdapterEvent{
		{Type: types.EventReasoning, Reasoning: "why"}, {Type: types.EventTextDelta, Text: "ok"},
		{Type: types.EventDone, Usage: &types.Usage{InputTokens: 12, OutputTokens: 3, CacheReadInputTokens: 4, CacheCreationInputTokens: 2}},
	}, "claude-requested")
	if err != nil {
		t.Fatal(err)
	}
	usage := body["usage"].(map[string]any)
	if usage["input_tokens"] != 6 || usage["cache_read_input_tokens"] != 4 {
		t.Fatalf("usage = %#v", usage)
	}
	content := body["content"].([]any)
	if content[0].(map[string]any)["type"] != "thinking" || content[1].(map[string]any)["text"] != "ok" {
		t.Fatalf("content = %#v", content)
	}
}

func TestWriteAnthropicStreamFailsClosedOnTruncation(t *testing.T) {
	events := make(chan types.AdapterEvent)
	close(events)
	w := httptest.NewRecorder()
	if err := writeAnthropicStream(context.Background(), w, "m", events); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(w.Body.String(), `event: error`) || !strings.Contains(w.Body.String(), `overloaded_error`) || strings.Contains(w.Body.String(), `message_stop`) {
		t.Fatalf("stream = %s", w.Body.String())
	}
}
