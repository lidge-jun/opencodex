package anthropic

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestBuildRequestAnthropicMessagesShape(t *testing.T) {
	temperature := 0.2
	adapter := &Adapter{BaseURL: "https://provider.test/v1", APIKey: "secret", Headers: map[string]string{"anthropic-beta": "test-beta"}}
	req := &types.NormalizedRequest{
		ModelID: "claude-test", Stream: true,
		Context: types.RequestContext{
			SystemPrompt: []string{"Be concise."},
			Messages: []types.Message{
				{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"hello"}]`)},
				{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","id":"toolu_1","namespace":"fs","name":"read","arguments":{"path":"a"}}]`)},
				{Role: "toolResult", ToolCallID: "toolu_1", ToolName: "read", Content: json.RawMessage(`"ok"`)},
			},
			Tools: []types.Tool{{Name: "read", Namespace: "fs", Description: "Read a file", Parameters: map[string]any{"properties": map[string]any{"path": map[string]any{"type": "string"}}}}},
		},
		Options: types.RequestOptions{MaxOutputTokens: 512, Temperature: &temperature, ToolChoice: json.RawMessage(`"required"`)},
	}
	httpReq, err := adapter.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got := httpReq.URL.String(); got != "https://provider.test/v1/messages" {
		t.Fatalf("URL = %q", got)
	}
	if httpReq.Header.Get("x-api-key") != "secret" || httpReq.Header.Get("anthropic-version") != "2023-06-01" || httpReq.Header.Get("Accept") != "text/event-stream" {
		t.Fatalf("unexpected headers: %#v", httpReq.Header)
	}
	var body map[string]any
	if err := json.NewDecoder(httpReq.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "claude-test" || body["max_tokens"] != float64(512) || body["stream"] != true {
		t.Fatalf("unexpected body: %#v", body)
	}
	tools := body["tools"].([]any)
	tool := tools[0].(map[string]any)
	if tool["name"] != "fs.read" || tool["input_schema"].(map[string]any)["type"] != "object" {
		t.Fatalf("unexpected tool: %#v", tool)
	}
	messages := body["messages"].([]any)
	assistant := messages[1].(map[string]any)["content"].([]any)[0].(map[string]any)
	if assistant["type"] != "tool_use" || assistant["name"] != "fs.read" {
		t.Fatalf("unexpected assistant tool block: %#v", assistant)
	}
	result := messages[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	if result["type"] != "tool_result" || result["tool_use_id"] != "toolu_1" || result["content"] != "ok" {
		t.Fatalf("unexpected tool result: %#v", result)
	}
}

func TestParseStreamAndUnary(t *testing.T) {
	stream := strings.Join([]string{
		`event: message_start`, `data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":2}}}`, "",
		`event: content_block_start`, `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`, "",
		`event: content_block_delta`, `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`, "",
		`event: content_block_stop`, `data: {"type":"content_block_stop","index":0}`, "",
		`event: content_block_start`, `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}`, "",
		`event: content_block_delta`, `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"q\":\"go\"}"}}`, "",
		`event: content_block_stop`, `data: {"type":"content_block_stop","index":1}`, "",
		`event: message_delta`, `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}`, "",
		`event: message_stop`, `data: {"type":"message_stop"}`, "", "",
	}, "\n")
	events := collectAdapterEvents((&Adapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 3 || events[0].Text != "hi" || events[1].ToolCall == nil || string(events[1].ToolCall.Arguments) != `{"q":"go"}` {
		t.Fatalf("unexpected stream events: %#v", events)
	}
	if events[2].Type != types.EventDone || events[2].Usage.InputTokens != 5 || events[2].Usage.OutputTokens != 4 || events[2].StopReason != "tool_use" {
		t.Fatalf("unexpected done event: %#v", events[2])
	}

	unary := []byte(`{"content":[{"type":"thinking","thinking":"consider"},{"type":"text","text":"answer"},{"type":"tool_use","id":"toolu_2","name":"run","input":{"x":1}}],"usage":{"input_tokens":2,"output_tokens":3},"stop_reason":"tool_use"}`)
	unaryEvents, err := (&Adapter{}).ParseUnary(context.Background(), unary)
	if err != nil || len(unaryEvents) != 4 || unaryEvents[0].Reasoning != "consider" || unaryEvents[1].Text != "answer" || unaryEvents[2].ToolCall == nil || unaryEvents[3].Type != types.EventDone {
		t.Fatalf("unexpected unary events: %#v, %v", unaryEvents, err)
	}
}

func TestBuildRequestUsesAdaptiveThinkingForNewClaudeFamilies(t *testing.T) {
	req := &types.NormalizedRequest{
		ModelID: "claude-opus-4-7", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		Options: types.RequestOptions{Reasoning: "minimal"},
	}
	httpReq, err := (&Adapter{}).BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.NewDecoder(httpReq.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["thinking"].(map[string]any)["type"] != "adaptive" || body["output_config"].(map[string]any)["effort"] != "low" {
		t.Fatalf("unexpected adaptive thinking body: %#v", body)
	}
}

func collectAdapterEvents(stream <-chan types.AdapterEvent) []types.AdapterEvent {
	var events []types.AdapterEvent
	for event := range stream {
		events = append(events, event)
	}
	return events
}
