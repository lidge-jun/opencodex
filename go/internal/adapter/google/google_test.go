package google

import (
	"context"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAIStudioBuildRequestCompilesMessagesToolsAndAuth(t *testing.T) {
	adapter := &Adapter{Mode: ModeAIStudio, BaseURL: "https://generativelanguage.googleapis.com", APIKey: "test-key"}
	req := &types.NormalizedRequest{
		ModelID: "gemini-3.6-flash", Options: types.RequestOptions{Reasoning: "high"},
		Context: types.RequestContext{
			SystemPrompt: []string{"You are Codex, a coding agent based on GPT-5."},
			Messages: []types.Message{
				{Role: "assistant", Content: rawJSON([]any{map[string]any{"type": "toolCall", "id": "fc:weird/id", "name": "run", "namespace": "mcp", "arguments": map[string]any{"cmd": "ls"}}})},
				{Role: "toolResult", ToolCallID: "fc:weird/id", ToolName: "mcp__run", Content: rawJSON([]any{map[string]any{"type": "text", "text": "ok"}, map[string]any{"type": "image", "imageUrl": "data:image/png;base64,aGVsbG8="}})},
			},
			Tools: []types.Tool{{Name: "9 bad tool", Description: "run", Parameters: map[string]any{"type": "object", "properties": map[string]any{"secret": map[string]any{"type": "string", "encrypted": true}}}}},
		},
	}
	httpReq, err := adapter.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if httpReq.URL.String() != "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent" {
		t.Fatalf("url = %s", httpReq.URL)
	}
	if httpReq.Header.Get("x-goog-api-key") != "test-key" {
		t.Fatal("missing API key header")
	}
	var body map[string]any
	decodeRequestBody(t, httpReq.Body, &body)
	instruction := body["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
	if strings.Contains(instruction, "based on GPT-5") || !strings.Contains(instruction, "Do not claim to be GPT-5") {
		t.Fatalf("identity was not neutralized: %q", instruction)
	}
	if !strings.Contains(instruction, "Tool contract") {
		t.Fatal("tool catalog nudge missing")
	}
	config := body["generationConfig"].(map[string]any)
	if config["thinkingConfig"].(map[string]any)["thinkingLevel"] != "high" {
		t.Fatalf("thinking config = %#v", config)
	}
	contents := body["contents"].([]any)
	call := contents[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["functionCall"].(map[string]any)
	response := contents[1].(map[string]any)["parts"].([]any)[0].(map[string]any)["functionResponse"].(map[string]any)
	if call["id"] != response["id"] || !regexpToolCallID.MatchString(call["id"].(string)) {
		t.Fatalf("tool ids did not normalize and pair: %#v %#v", call["id"], response["id"])
	}
	parts := contents[1].(map[string]any)["parts"].([]any)
	if len(parts) != 2 {
		t.Fatalf("tool result image was not inlined: %#v", parts)
	}
	declaration := body["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)
	if declaration["name"] == "9 bad tool" || strings.Contains(string(rawJSON(declaration["parameters"])), "encrypted") {
		t.Fatalf("tool declaration was not compiled: %#v", declaration)
	}
}

var regexpToolCallID = regexp.MustCompile(`^fc_weird_id_[0-9a-f]{8}$`)

func TestAntigravityBuildRequestWrapsEnvelopeAndVertexSelectsOAuth(t *testing.T) {
	req := &types.NormalizedRequest{ModelID: "gemini-3.6-flash", Stream: true, Options: types.RequestOptions{Reasoning: "low"}, Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: rawJSON("hello")}}}}
	cca := &Adapter{Mode: ModeCloudCodeAssist, BaseURL: "https://daily-cloudcode-pa.googleapis.com", AccessToken: "oauth-token", Project: "proj"}
	httpReq, err := cca.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if httpReq.URL.String() != "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse" {
		t.Fatalf("url = %s", httpReq.URL)
	}
	if httpReq.Header.Get("Authorization") != "Bearer oauth-token" || httpReq.Header.Get("User-Agent") == "antigravity" {
		t.Fatalf("CCA headers = %#v", httpReq.Header)
	}
	var envelope map[string]any
	decodeRequestBody(t, httpReq.Body, &envelope)
	if envelope["model"] != "gemini-3.6-flash-low" || envelope["userAgent"] != "antigravity" {
		t.Fatalf("envelope = %#v", envelope)
	}
	request := envelope["request"].(map[string]any)
	if !strings.HasPrefix(request["sessionId"].(string), "-") {
		t.Fatalf("session = %#v", request["sessionId"])
	}
	if _, exists := envelope["sessionId"]; exists {
		t.Fatal("session id leaked outside request envelope")
	}

	vertex := &Adapter{Mode: ModeVertex, AccessToken: "adc-token", Project: "p", Location: "us-central1"}
	vertexReq, err := vertex.BuildRequest(context.Background(), &types.NormalizedRequest{ModelID: "gemini-3-pro", Context: req.Context})
	if err != nil {
		t.Fatal(err)
	}
	if vertexReq.URL.Host != "us-central1-aiplatform.googleapis.com" || vertexReq.Header.Get("Authorization") != "Bearer adc-token" {
		t.Fatalf("Vertex request = %s %#v", vertexReq.URL, vertexReq.Header)
	}
}

func TestParseGeminiStreamAndUnary(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	stream := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"},{\"functionCall\":{\"id\":\"call_1\",\"name\":\"run\",\"args\":{\"x\":1}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":2}}\n\n"
	events := collectEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 3 || events[0].Type != types.EventTextDelta || events[1].Type != types.EventToolCall || events[2].Type != types.EventDone {
		t.Fatalf("events = %#v", events)
	}
	if events[2].Usage == nil || events[2].Usage.TotalTokens != 5 {
		t.Fatalf("usage = %#v", events[2].Usage)
	}

	truncated := rawJSON(map[string]any{
		"candidates": []any{map[string]any{
			"content":      map[string]any{"parts": []any{map[string]any{"functionCall": map[string]any{"name": "run", "args": map[string]any{}}}}},
			"finishReason": "MAX_TOKENS",
		}},
	})
	unary, err := adapter.ParseUnary(context.Background(), truncated)
	if err != nil {
		t.Fatal(err)
	}
	if len(unary) != 1 || unary[0].Type != types.EventError || !strings.Contains(unary[0].Error, "truncated upstream") {
		t.Fatalf("truncation events = %#v", unary)
	}
}

func TestParseGeminiStreamUsageOnlyFinalFrameDone(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	stream := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n" +
		"data: {\"usageMetadata\":{\"promptTokenCount\":7,\"candidatesTokenCount\":3}}\n\n"
	events := collectEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	done := events[len(events)-1]
	if done.Type != types.EventDone || done.Usage == nil || done.Usage.InputTokens != 7 || done.Usage.OutputTokens != 3 {
		t.Fatalf("events = %#v", events)
	}
}

func TestParseGeminiStreamTextOnlyMaxTokensDone(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	stream := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]},\"finishReason\":\"MAX_TOKENS\"}]}\n\n"
	events := collectEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	done := events[len(events)-1]
	if done.Type != types.EventDone || done.StopReason != "max_tokens" {
		t.Fatalf("events = %#v", events)
	}
	for _, event := range events {
		if event.Type == types.EventError {
			t.Fatalf("unexpected truncation error: %#v", events)
		}
	}
}

func TestParseGeminiStreamRejectsUnterminatedNonDataResidual(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	stream := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]},\"finishReason\":\"STOP\"}]}\n\ngarbage-without-newline"
	events := collectEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	last := events[len(events)-1]
	if last.Type != types.EventError || last.Error != "upstream stream ended with an incomplete SSE frame — possible truncation" {
		t.Fatalf("events = %#v", events)
	}
}

func TestParseGeminiStreamRequiresTerminalSignal(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	stream := "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n"
	events := collectEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	last := events[len(events)-1]
	if last.Type != types.EventError || last.Error != "upstream stream ended without a terminal signal — possible truncation" {
		t.Fatalf("events = %#v", events)
	}
}

func TestParseGeminiStreamRejectsMalformedDataFrame(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	events := collectEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader("data: {invalid\n\n"))))
	if len(events) != 1 || events[0].Type != types.EventError || events[0].Error != "malformed upstream SSE data frame" {
		t.Fatalf("events = %#v", events)
	}
}

func TestParseGeminiStreamEmitsHeartbeatForLivenessOnlyRead(t *testing.T) {
	adapter := &Adapter{Mode: ModeVertex}
	body := io.NopCloser(&chunkReader{chunks: []string{
		"data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}\n\n",
		": keepalive\n\n",
		"data: {\"usageMetadata\":{\"promptTokenCount\":1,\"candidatesTokenCount\":1}}\n\n",
	}})
	events := collectEvents(adapter.ParseStream(context.Background(), body))
	sawHeartbeat := false
	for _, event := range events {
		if event.Type == types.EventHeartbeat {
			sawHeartbeat = true
		}
	}
	if !sawHeartbeat || events[len(events)-1].Type != types.EventDone {
		t.Fatalf("events = %#v", events)
	}
}

func TestAntigravityParserRejectsMissingWrapper(t *testing.T) {
	adapter := &Adapter{Mode: ModeCloudCodeAssist}
	events, err := adapter.ParseUnary(context.Background(), rawJSON(map[string]any{"candidates": []any{}}))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Error != "google-antigravity response missing response wrapper" {
		t.Fatalf("events = %#v", events)
	}
}

func rawJSON(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func decodeRequestBody(t *testing.T, body io.Reader, target any) {
	t.Helper()
	if err := json.NewDecoder(body).Decode(target); err != nil {
		t.Fatal(err)
	}
}

func collectEvents(channel <-chan types.AdapterEvent) []types.AdapterEvent {
	events := make([]types.AdapterEvent, 0)
	for event := range channel {
		events = append(events, event)
	}
	return events
}

type chunkReader struct {
	chunks []string
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := r.chunks[0]
	r.chunks = r.chunks[1:]
	return copy(p, chunk), nil
}
