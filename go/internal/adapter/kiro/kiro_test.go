package kiro

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestThinkingSplitterAcrossChunkBoundaries(t *testing.T) {
	parser := NewThinkingSplitter()
	if got := parser.Feed("  <thin"); len(got) != 0 {
		t.Fatalf("partial tag emitted: %#v", got)
	}
	got := append(parser.Feed("king>private</think"), parser.Feed("ing> public")...)
	var reasoning, text strings.Builder
	for _, event := range got {
		if event.Reasoning {
			reasoning.WriteString(event.Text)
		} else {
			text.WriteString(event.Text)
		}
	}
	if reasoning.String() != "private" || text.String() != "public" {
		t.Fatalf("unexpected split: %#v", got)
	}
}

func TestWireNamesAreDeterministicBoundedAndRestorable(t *testing.T) {
	registry := NewToolNameRegistry()
	wire := "codex_apps__workspace agents_create_agent_with_a_name_that_is_far_too_long_for_kiro"
	alias, err := registry.Alias(wire)
	if err != nil {
		t.Fatal(err)
	}
	if len(alias) > 64 || strings.Contains(alias, " ") {
		t.Fatalf("invalid alias %q", alias)
	}
	if restored := registry.Restore(alias); restored != wire {
		t.Fatalf("restore=%q", restored)
	}
	second, _ := registry.Alias(wire)
	if alias != second {
		t.Fatalf("alias changed: %q != %q", alias, second)
	}
	if id := InvocationID(); !IsValidConversationID(id) {
		t.Fatalf("invalid invocation id %q", id)
	}
	if got := MapModelID("kiro-claude-4-6-sonnet-high"); got != "claude-sonnet-4.6" {
		t.Fatalf("model=%q", got)
	}
}

func TestConvertToolsSanitizesSchemaWithoutDeletingPropertyNames(t *testing.T) {
	req := &types.NormalizedRequest{ModelID: "claude-sonnet-5", Context: types.RequestContext{Tools: []types.Tool{{Name: "read", Namespace: "memories", Parameters: map[string]any{
		"oneOf":                []any{map[string]any{"properties": map[string]any{"pattern": map[string]any{"type": "string", "pattern": "secret"}}, "required": []any{"pattern"}}},
		"additionalProperties": false,
	}}}}}
	tools, err := ConvertTools(req, NewToolNameRegistry())
	if err != nil {
		t.Fatal(err)
	}
	spec := tools[0]["toolSpecification"].(map[string]any)
	if spec["name"] != "memories__read" {
		t.Fatalf("name=%v", spec["name"])
	}
	schema := spec["inputSchema"].(map[string]any)["json"].(map[string]any)
	if schema["type"] != "object" || schema["oneOf"] != nil || schema["additionalProperties"] != nil {
		t.Fatalf("schema=%#v", schema)
	}
	properties := schema["properties"].(map[string]any)
	patternProperty := properties["pattern"].(map[string]any)
	if patternProperty["pattern"] != nil {
		t.Fatalf("nested validation keyword survived: %#v", patternProperty)
	}
}

func TestImagesCountAndBudgetDropOldest(t *testing.T) {
	images := make([]Image, MaxImagesPerMessage+2)
	for i := range images {
		images[i] = Image{Format: "jpeg", Source: ImageSource{Bytes: strings.Repeat("x", ImageBase64Budget/MaxImagesPerMessage+1)}}
	}
	carrier := &imageCarrier{Images: images}
	NormalizeImageCarriers([]*imageCarrier{carrier})
	if len(carrier.Images) >= MaxImagesPerMessage {
		t.Fatalf("budget/count did not drop images: %d", len(carrier.Images))
	}
	if !strings.Contains(carrier.Content, "20-image") || !strings.Contains(carrier.Content, "budget exceeded") {
		t.Fatalf("missing omission notes: %q", carrier.Content)
	}
	parsed, ok := ParseDataURLImage("data:image/jpg;base64,YQ==")
	if !ok || parsed.Format != "jpeg" || parsed.Source.Bytes != "YQ==" {
		t.Fatalf("image=%#v ok=%v", parsed, ok)
	}
}

func TestParseEventRejectsMalformedUsage(t *testing.T) {
	_, err := ParseEvent("metadataEvent", []byte(`{"tokenUsage":{"uncachedInputTokens":-1,"outputTokens":1,"totalTokens":1}}`))
	if err == nil || !strings.Contains(err.Error(), "uncachedInputTokens") {
		t.Fatalf("err=%v", err)
	}
	if event, err := ParseEvent("futureEvent", []byte(`not-json`)); err != nil || event != nil {
		t.Fatalf("unknown event parsed: %#v %v", event, err)
	}
}

func TestBuildPayloadConversationAndNativeReasoning(t *testing.T) {
	parallel := false
	req := &types.NormalizedRequest{ModelID: "kiro-gpt-5-6-sol", Metadata: map[string]string{"kiro.conversationId": "thread:123"}, Options: types.RequestOptions{Reasoning: "high", ParallelToolCalls: &parallel}, Context: types.RequestContext{
		SystemPrompt: []string{"system"},
		Messages:     []types.Message{{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"hello"},{"type":"image","imageUrl":"data:image/png;base64,YQ=="}]`)}},
		Tools:        []types.Tool{{Name: "run", Description: "run it", Parameters: map[string]any{"type": "object"}}},
	}}
	payload, _, conversationID, mode, err := BuildPayload(req, "arn:test", "")
	if err != nil {
		t.Fatal(err)
	}
	if conversationID != "thread:123" || mode != CompletionRequired {
		t.Fatalf("conversation=%q mode=%q", conversationID, mode)
	}
	if payload["profileArn"] != "arn:test" {
		t.Fatalf("profile=%v", payload["profileArn"])
	}
	fields := payload["additionalModelRequestFields"].(map[string]any)
	if fields["reasoning"].(map[string]string)["effort"] != "high" {
		t.Fatalf("fields=%#v", fields)
	}
	encoded, _ := json.Marshal(payload)
	text := string(encoded)
	if !strings.Contains(text, `"images":[{"format":"png","source":{"bytes":"YQ=="}}]`) || !strings.Contains(text, CompletionToolName) {
		t.Fatalf("payload=%s", text)
	}
}

func TestParseStreamToolUsageAndTerminalError(t *testing.T) {
	stream := smithyStream(t,
		eventFrame(t, "toolUseEvent", map[string]any{"name": "shell", "toolUseId": "toolu_1", "input": "{\"cmd\":"}),
		eventFrame(t, "toolUseEvent", map[string]any{"input": "\"pwd\"}", "stop": true}),
		eventFrame(t, "metadataEvent", map[string]any{"tokenUsage": map[string]any{"uncachedInputTokens": 2, "cacheReadInputTokens": 3, "outputTokens": 4, "totalTokens": 9}}),
	)
	adapter := &Adapter{}
	events := collect(adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(stream))))
	if len(events) != 2 || events[0].Type != types.EventToolCall || events[0].ToolCall.Name != "shell" || string(events[0].ToolCall.Arguments) != `{"cmd":"pwd"}` {
		t.Fatalf("events=%#v", events)
	}
	if events[1].Type != types.EventDone || events[1].Usage == nil || events[1].Usage.InputTokens != 5 {
		t.Fatalf("done=%#v", events[1])
	}

	errorStream := smithyStream(t, exceptionFrame(t, "ThrottlingException", map[string]any{"message": "rate limit"}))
	errorEvents := collect(adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(errorStream))))
	if len(errorEvents) != 1 || errorEvents[0].Type != types.EventError || !errorEvents[0].Retryable {
		t.Fatalf("error events=%#v", errorEvents)
	}
}

func TestParseAttemptProgressTextWithoutCompletionIsNonterminal(t *testing.T) {
	stream := smithyStream(t, eventFrame(t, "assistantResponseEvent", map[string]any{"content": "Checking the result."}))
	result := parseAttempt(context.Background(), io.NopCloser(bytes.NewReader(stream)), CompletionRequired, 0, nil, "")

	if !result.needsFallback {
		t.Fatal("progress-only response did not request completion fallback")
	}
	if len(result.events) != 1 || result.events[0].Type != types.EventTextDelta || result.events[0].Text != "Checking the result." || result.events[0].Phase != "commentary" {
		t.Fatalf("events=%#v", result.events)
	}
	for _, event := range result.events {
		if event.Type == types.EventDone {
			t.Fatalf("progress-only response emitted done: %#v", result.events)
		}
	}
}

func TestParseAttemptCompletionToolEmitsDone(t *testing.T) {
	stream := smithyStream(t,
		eventFrame(t, "toolUseEvent", map[string]any{"name": CompletionToolName, "toolUseId": "final_1", "input": `{"answer":`}),
		eventFrame(t, "toolUseEvent", map[string]any{"input": `"Task complete."}`, "stop": true}),
	)
	result := parseAttempt(context.Background(), io.NopCloser(bytes.NewReader(stream)), CompletionRequired, 0, nil, "")

	if result.needsFallback {
		t.Fatal("completed response requested fallback")
	}
	if len(result.events) != 2 || result.events[0].Type != types.EventTextDelta || result.events[0].Text != "Task complete." || result.events[0].Phase != "final_answer" || result.events[1].Type != types.EventDone {
		t.Fatalf("events=%#v", result.events)
	}
}

func TestBoundedCompletionRetryRunsOnce(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/vnd.amazon.eventstream")
		_, _ = w.Write(smithyStream(t,
			eventFrame(t, "toolUseEvent", map[string]any{"name": CompletionToolName, "toolUseId": "final_1", "input": "{\"answer\":"}),
			eventFrame(t, "toolUseEvent", map[string]any{"input": "\"done\"}", "stop": true}),
			eventFrame(t, "metadataEvent", map[string]any{"tokenUsage": map[string]any{"uncachedInputTokens": 2, "outputTokens": 1, "totalTokens": 3}}),
		))
	}))
	defer server.Close()
	adapter := NewAdapter(server.URL, "token")
	req := &types.NormalizedRequest{ModelID: "claude-sonnet-5", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"question"`)}}, Tools: []types.Tool{{Name: "shell", Parameters: map[string]any{"type": "object"}}}}}
	if _, err := adapter.BuildRequest(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	first := smithyStream(t, eventFrame(t, "reasoningContentEvent", map[string]any{"text": "thinking"}), eventFrame(t, "metadataEvent", map[string]any{"tokenUsage": map[string]any{"uncachedInputTokens": 1, "outputTokens": 1, "totalTokens": 2}}))
	events := collect(adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(first))))
	if attempts.Load() != 1 {
		t.Fatalf("fallback attempts=%d", attempts.Load())
	}
	if len(events) < 3 || events[len(events)-2].Type != types.EventTextDelta || events[len(events)-2].Text != "done" || events[len(events)-1].Type != types.EventDone {
		t.Fatalf("events=%#v", events)
	}
	if events[len(events)-1].Usage.InputTokens != 3 {
		t.Fatalf("usage=%#v", events[len(events)-1].Usage)
	}
}

func TestErrorClassificationAndTruncation(t *testing.T) {
	failure := ClassifyHTTPError(400, http.Header{}, `{"__type":"content_length_exceeds_threshold","message":"token=secret-value"}`)
	if failure.Code != "context_length_exceeded" || failure.Retryable {
		t.Fatalf("failure=%#v", failure)
	}
	if IsCompleteToolInput(`{"a":`) {
		t.Fatal("truncated JSON accepted")
	}
	if !IsCompleteToolInput(`{}`) {
		t.Fatal("complete JSON rejected")
	}
}

type resetTransport struct{ calls atomic.Int32 }

func (r *resetTransport) RoundTrip(*http.Request) (*http.Response, error) {
	if r.calls.Add(1) < 3 {
		return nil, syscall.ECONNRESET
	}
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("ok"))}, nil
}

func TestDoWithRetryRecoversConnectionReset(t *testing.T) {
	transport := &resetTransport{}
	client := &http.Client{Transport: transport}
	request, _ := http.NewRequest(http.MethodPost, "https://example.test", strings.NewReader("body"))
	response, err := DoWithRetry(context.Background(), client, request)
	if err != nil || response.StatusCode != 200 || transport.calls.Load() != 3 {
		t.Fatalf("response=%v err=%v calls=%d", response, err, transport.calls.Load())
	}
}

type transientTransport struct{ calls atomic.Int32 }

func (r *transientTransport) RoundTrip(*http.Request) (*http.Response, error) {
	status := http.StatusServiceUnavailable
	if r.calls.Add(1) == 3 {
		status = http.StatusOK
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("body"))}, nil
}

func TestDoWithRetryRecoversTransientStatus(t *testing.T) {
	transport := &transientTransport{}
	client := &http.Client{Transport: transport}
	request, _ := http.NewRequest(http.MethodPost, "https://example.test", strings.NewReader("body"))
	response, err := DoWithRetry(context.Background(), client, request)
	if err != nil || response.StatusCode != http.StatusOK || transport.calls.Load() != 3 {
		t.Fatalf("response=%v err=%v calls=%d", response, err, transport.calls.Load())
	}
}

func eventFrame(t *testing.T, eventType string, payload any) []byte {
	return encodeFrame(t, map[string]string{":message-type": "event", ":event-type": eventType}, payload)
}
func exceptionFrame(t *testing.T, errorType string, payload any) []byte {
	return encodeFrame(t, map[string]string{":message-type": "exception", ":exception-type": errorType}, payload)
}
func encodeFrame(t *testing.T, headers map[string]string, payload any) []byte {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	wireHeaders := map[string]protocol.SmithyHeaderValue{}
	for key, value := range headers {
		wireHeaders[key] = protocol.SmithyHeaderValue{Type: protocol.SmithyHeaderString, Value: value}
	}
	var out bytes.Buffer
	if err := protocol.EncodeSmithyFrame(&out, &protocol.SmithyFrame{Headers: wireHeaders, Payload: encoded}); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func smithyStream(t *testing.T, frames ...[]byte) []byte { t.Helper(); return bytes.Join(frames, nil) }
func collect(stream <-chan types.AdapterEvent) []types.AdapterEvent {
	var out []types.AdapterEvent
	for event := range stream {
		out = append(out, event)
	}
	return out
}
