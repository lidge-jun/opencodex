package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAliasRoundTripAndGuards(t *testing.T) {
	alias, ok := AliasForRoute("openrouter", "model--variant")
	if !ok || alias != "claude-ocx-openrouter--model--variant" {
		t.Fatalf("alias = %q, %v", alias, ok)
	}
	if got, ok := ResolveAlias(alias); !ok || got != "openrouter/model--variant" {
		t.Fatalf("resolved = %q, %v", got, ok)
	}
	if _, ok := AliasForRoute("bad--provider", "m"); ok {
		t.Fatal("ambiguous provider was aliased")
	}
	if native, ok := AliasForNative("gpt-5.6"); !ok {
		t.Fatal("native alias rejected")
	} else if got, _ := ResolveAlias(native); got != "gpt-5.6" {
		t.Fatalf("native resolved %q", got)
	}
}

func TestContextWindowsAndOneMillionVariants(t *testing.T) {
	windows := BuildClaudeContextWindows(map[string]int{"gpt": 1_050_000}, []ContextModel{{Provider: "p", ID: "m", ContextWindow: 372_000}, {Provider: "anthropic", ID: "claude-small", ContextWindow: 372_000}})
	if windows["gpt"] != 1_050_000 || windows["p/m"] != 372_000 {
		t.Fatalf("windows = %#v", windows)
	}
	if _, ok := windows["anthropic/claude-small"]; ok {
		t.Fatal("sub-1m Anthropic route was registered")
	}
	auto := AutoContextMode{Enabled: true, CompactWindow: 350_000}
	if got := WithOneMillionMarker("p/m", windows, auto); got != "p/m[1m]" {
		t.Fatalf("marker = %q", got)
	}
	if got := StripOneMillionMarker("p/m[1M]"); got != "p/m" {
		t.Fatalf("strip = %q", got)
	}
}

func TestModelInfoAdvertisesOnlyDeclaredCapabilities(t *testing.T) {
	infos := BuildModelInfos(nil, []DiscoveryModel{{Provider: "p", ID: "vision", ReasoningEfforts: []string{"low", "ultra"}, ContextWindow: 372_000, ImageInput: true}}, AutoContextMode{Enabled: true, CompactWindow: 350_000})
	if len(infos) != 2 || infos[0].Capabilities.Effort.High.Supported || !infos[0].Capabilities.Effort.Low.Supported {
		t.Fatalf("infos = %#v", infos)
	}
	if !strings.Contains(infos[1].DisplayName, "372k") || infos[1].MaxInputTokens == nil || *infos[1].MaxInputTokens != 372_000 {
		t.Fatalf("variant = %#v", infos[1])
	}
}

func TestReasoningEnvelopeRoundTripAndRejectsGarbage(t *testing.T) {
	want := ReasoningEnvelope{Signature: "sig", Redacted: []string{"red"}, Text: "hidden"}
	got, ok := DecodeReasoningEnvelope(EncodeReasoningEnvelope(want))
	if !ok || got.Signature != want.Signature || got.Text != want.Text || len(got.Redacted) != 1 {
		t.Fatalf("got %#v, %v", got, ok)
	}
	if _, ok := DecodeReasoningEnvelope("native-encrypted"); ok {
		t.Fatal("native blob decoded")
	}
}

func TestAnthropicInboundToolsThinkingCacheAndElision(t *testing.T) {
	large := "Base directory for this skill: /tmp/claude-api\n" + strings.Repeat("x", 10_100)
	body := map[string]any{"model": "claude-ocx-p--m[1m]", "system": "sys", "metadata": map[string]any{"user_id": "session"}, "max_tokens": float64(99), "thinking": map[string]any{"type": "enabled", "budget_tokens": float64(5000)}, "tools": []any{map[string]any{"name": "run", "description": "d", "input_schema": map[string]any{"type": "object"}}}, "messages": []any{
		map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "skill1", "name": "Skill", "input": map[string]any{"skill": "claude-api"}}}},
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "skill1", "content": "Launching"}, map[string]any{"type": "text", "text": large}}},
	}}
	translated, err := AnthropicToResponses(body, nil)
	if err != nil {
		t.Fatal(err)
	}
	if translated.Body["model"] != "p/m" || translated.CacheKeySource != "metadata" {
		t.Fatalf("translation = %#v", translated)
	}
	reasoning := translated.Body["reasoning"].(map[string]any)
	if reasoning["effort"] != "medium" {
		t.Fatalf("reasoning = %#v", reasoning)
	}
	input := translated.Body["input"].([]any)
	wire, _ := json.Marshal(input)
	if strings.Contains(string(wire), strings.Repeat("x", 100)) || !strings.Contains(string(wire), "elided") {
		t.Fatalf("skill was not elided: %s", wire)
	}
}

func TestParseResponsesItemsAndReasoningEnvelope(t *testing.T) {
	envelope := EncodeReasoningEnvelope(ReasoningEnvelope{Signature: "signed", Text: "secret"})
	raw := []byte(`{"model":"p/m","instructions":"sys","reasoning":{"effort":"ultra"},"tools":[{"type":"function","name":"run","parameters":{"type":"object"}}],"input":[{"type":"reasoning","encrypted_content":"` + envelope + `"},{"type":"function_call","call_id":"c1","name":"run","arguments":"{\"x\":1}"},{"type":"function_call_output","call_id":"c1","output":"ok"},{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AA","detail":"original"}]}]}`)
	req, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if req.Options.Reasoning != "max" || len(req.Context.Tools) != 1 || len(req.Context.Messages) != 3 {
		t.Fatalf("request = %#v", req)
	}
	if !strings.Contains(string(req.Context.Messages[0].Content), "signed") || req.Context.Messages[1].ToolCallID != "c1" || req.Context.Messages[1].ToolName != "run" {
		t.Fatalf("messages = %#v", req.Context.Messages)
	}
	if !strings.Contains(string(req.Context.Messages[2].Content), `"detail":"high"`) {
		t.Fatalf("image = %s", req.Context.Messages[2].Content)
	}
}

func TestResponsesValidationRejectsMalformedBoundaries(t *testing.T) {
	cases := [][]byte{[]byte(`{}`), []byte(`{"model":"m","input":{}}`), []byte(`{"model":"m","input":[{"type":"function_call","name":"x"}]}`), []byte(`{"model":"m","tool_choice":"sometimes"}`)}
	for _, raw := range cases {
		if _, err := ValidateResponsesRequest(raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestOutboundLifecycleThinkingToolChunksAndUsage(t *testing.T) {
	events := []types.AdapterEvent{{Type: types.EventReasoning, Reasoning: "why"}, {Type: types.EventTextDelta, Text: "answer"}, {Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "c1", Name: "run", Arguments: json.RawMessage(`{"x":`)}}, {Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "c1", Name: "run", Arguments: json.RawMessage(`1}`)}}, {Type: types.EventDone, Usage: &types.Usage{InputTokens: 15, OutputTokens: 4, CacheReadInputTokens: 5}}}
	wire, message := ConvertEvents("m", events)
	text := string(wire)
	order := []string{"event: message_start", "event: content_block_start", "thinking_delta", "signature_delta", "event: content_block_stop", "text_delta", "input_json_delta", "event: message_delta", "event: message_stop"}
	at := -1
	for _, needle := range order {
		next := strings.Index(text[at+1:], needle)
		if next < 0 {
			t.Fatalf("missing/out of order %q in %s", needle, text)
		}
		at += next + 1
	}
	if message.StopReason != "tool_use" || message.Usage["input_tokens"] != 10 || len(message.Content) != 3 {
		t.Fatalf("message = %#v", message)
	}
	if input := message.Content[2]["input"].(map[string]any); input["x"] != float64(1) {
		t.Fatalf("tool input = %#v", input)
	}
}

func TestOutboundClosedChannelFailsClosed(t *testing.T) {
	ch := make(chan types.AdapterEvent)
	close(ch)
	var b strings.Builder
	if err := StreamEvents(context.Background(), &b, "m", ch); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), "adapter stream ended") || strings.Contains(b.String(), "event: message_stop") {
		t.Fatalf("wire = %s", b.String())
	}
}

func TestContinuationExpansionProviderStateAndPersistence(t *testing.T) {
	store := NewResponseStateStore()
	request := map[string]any{"input": []any{map[string]any{"role": "user", "content": "q"}}, "store": false}
	response := map[string]any{"id": "r1", "status": "completed", "output": []any{map[string]any{"type": "function_call", "call_id": "c"}}}
	provider := ProviderState{"cursor": map[string]any{"conversationId": "conv"}}
	store.Remember(request, response, provider, true)
	expanded := store.Expand(map[string]any{"previous_response_id": "r1", "input": "next"})
	if len(expanded["input"].([]any)) != 3 {
		t.Fatalf("expanded = %#v", expanded)
	}
	cursor := store.ProviderState("r1")["cursor"].(map[string]any)
	if cursor["checkpointUsable"] != false {
		t.Fatalf("cursor = %#v", cursor)
	}
	path := filepath.Join(t.TempDir(), "state.json")
	if err := store.Save(path); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0600 {
			t.Fatalf("mode = %o", info.Mode().Perm())
		}
	}
	loaded := NewResponseStateStore()
	if err := loaded.Load(path); err != nil {
		t.Fatal(err)
	}
	if loaded.ProviderState("r1")["cursor"] == nil {
		t.Fatal("provider state not persisted")
	}
}
