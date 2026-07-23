package chat

import (
	"encoding/json"
	"testing"
)

func TestParseInboundTranslatesMessagesToolsImagesAndOptions(t *testing.T) {
	raw := []byte(`{
		"model":"acme/model","stream":true,"max_completion_tokens":321,
		"reasoning_effort":"high","stop":["END"],"parallel_tool_calls":false,
		"messages":[
			{"role":"system","content":"be terse"},
			{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]},
			{"role":"assistant","content":"checking","tool_calls":[{"id":"call_1","type":"function","function":{"name":"inspect","arguments":"{\"x\":1}"}}]},
			{"role":"tool","tool_call_id":"call_1","content":"ok"}
		],
		"tools":[{"type":"function","function":{"name":"inspect","description":"inspect it","parameters":{"type":"object"},"strict":true}}]
	}`)
	req, err := ParseInbound(raw)
	if err != nil {
		t.Fatal(err)
	}
	if req.ModelID != "acme/model" || !req.Stream || req.Options.MaxOutputTokens != 321 || req.Options.Reasoning != "high" {
		t.Fatalf("request = %+v", req)
	}
	if len(req.Context.SystemPrompt) != 1 || req.Context.SystemPrompt[0] != "be terse" {
		t.Fatalf("system = %#v", req.Context.SystemPrompt)
	}
	if len(req.Context.Messages) != 3 {
		t.Fatalf("messages = %#v", req.Context.Messages)
	}
	if len(req.Context.Tools) != 1 || req.Context.Tools[0].Name != "inspect" || !req.Context.Tools[0].Strict {
		t.Fatalf("tools = %#v", req.Context.Tools)
	}
	var user []map[string]any
	if err := json.Unmarshal(req.Context.Messages[0].Content, &user); err != nil {
		t.Fatal(err)
	}
	if user[1]["type"] != "input_image" || user[1]["image_url"] != "data:image/png;base64,AA==" {
		t.Fatalf("user blocks = %#v", user)
	}
	var assistant []map[string]any
	if err := json.Unmarshal(req.Context.Messages[1].Content, &assistant); err != nil {
		t.Fatal(err)
	}
	if assistant[1]["type"] != "toolCall" || assistant[1]["name"] != "inspect" {
		t.Fatalf("assistant = %#v", assistant)
	}
	if req.Context.Messages[2].Role != "toolResult" || req.Context.Messages[2].ToolCallID != "call_1" {
		t.Fatalf("tool result = %+v", req.Context.Messages[2])
	}
}

func TestParseInboundRejectsMalformedToolHistory(t *testing.T) {
	_, err := ParseInbound([]byte(`{"model":"m","messages":[{"role":"tool","content":"x"}]}`))
	if err == nil || err.Error() != "tool messages require tool_call_id" {
		t.Fatalf("error = %v", err)
	}

	_, err = ParseInbound([]byte(`{"model":"m","messages":[{"role":"assistant","tool_calls":[{"id":"call_1","function":{"arguments":"{}"}}]}]}`))
	if err == nil || err.Error() != "tool_calls entries require function.name" {
		t.Fatalf("error = %v", err)
	}
}

func TestParseAnthropicInboundTranslatesToolAndThinking(t *testing.T) {
	req, model, err := parseAnthropicInbound([]byte(`{
		"model":"claude-x","max_tokens":100,"thinking":{"type":"enabled","budget_tokens":8000},
		"messages":[
			{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"read","input":{"path":"a"}}]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"done"},{"type":"image","source":{"type":"url","url":"https://example.test/a.png"}}]}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if model != "claude-x" || req.Options.Reasoning != "medium" || req.Options.MaxOutputTokens != 100 {
		t.Fatalf("request = %+v", req)
	}
	if len(req.Context.Messages) != 3 || req.Context.Messages[1].Role != "toolResult" || req.Context.Messages[1].ToolCallID != "toolu_1" {
		t.Fatalf("messages = %#v", req.Context.Messages)
	}
}

func TestInboundDropsUnknownOrDisabledReasoningEffort(t *testing.T) {
	chat, err := ParseInbound([]byte(`{"model":"m","reasoning_effort":"extreme","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if chat.Options.Reasoning != "" {
		t.Fatalf("chat effort = %q", chat.Options.Reasoning)
	}
	claude, _, err := parseAnthropicInbound([]byte(`{"model":"m","max_tokens":10,"thinking":{"type":"disabled"},"output_config":{"effort":"high"},"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if claude.Options.Reasoning != "" {
		t.Fatalf("claude effort = %q", claude.Options.Reasoning)
	}
}
