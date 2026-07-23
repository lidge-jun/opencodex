package claude

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func ParseResponsesRequest(raw []byte) (*types.NormalizedRequest, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("responses parse error: %w", err)
	}
	expanded := ExpandPreviousResponseInput(body)
	raw, _ = json.Marshal(expanded)
	request, err := ValidateResponsesRequest(raw)
	if err != nil {
		return nil, err
	}
	return parseValidatedRequest(request, raw)
}

func parseValidatedRequest(data ResponsesRequest, raw []byte) (*types.NormalizedRequest, error) {
	now := time.Now().UnixMilli()
	context := types.RequestContext{}
	if data.Instructions != nil && *data.Instructions != "" {
		context.SystemPrompt = append(context.SystemPrompt, *data.Instructions)
	}
	appendMessage := func(role string, content any) {
		context.Messages = append(context.Messages, types.Message{Role: role, Content: mustRaw(content), Timestamp: now})
	}
	switch input := data.Input.(type) {
	case string:
		appendMessage("user", input)
	case []any:
		for _, value := range input {
			item := value.(map[string]any)
			kind := stringField(item, "type")
			if kind == "" && stringField(item, "role") != "" {
				kind = "message"
			}
			switch kind {
			case "message":
				role := stringField(item, "role")
				content := normalizeContent(item["content"], role == "assistant")
				if role == "system" {
					if text := flattenText(content); text != "" {
						context.SystemPrompt = append(context.SystemPrompt, text)
					}
				} else {
					appendMessage(role, content)
				}
			case "reasoning":
				text := reasoningText(item)
				envelope, ok := DecodeReasoningEnvelope(stringField(item, "encrypted_content"))
				if ok && envelope.Text != "" {
					text = envelope.Text
				}
				if text != "" {
					ensureAssistant(&context, now).Content = appendContent(ensureAssistant(&context, now).Content, map[string]any{"type": "thinking", "thinking": text, "signature": firstNonEmpty(envelope.Signature, stringField(item, "encrypted_content")), "redacted": envelope.Redacted})
				}
			case "function_call", "custom_tool_call", "local_shell_call", "tool_search_call":
				callID := firstNonEmpty(stringField(item, "call_id"), stringField(item, "id"))
				name := stringField(item, "name")
				args := map[string]any{}
				if kind == "tool_search_call" {
					name = "tool_search"
				}
				if kind == "local_shell_call" {
					name = "local_shell"
				}
				if kind == "custom_tool_call" {
					args["input"], _ = item["input"].(string)
				} else if s, _ := item["arguments"].(string); s != "" {
					_ = json.Unmarshal([]byte(s), &args)
				}
				m := ensureAssistant(&context, now)
				m.Content = appendContent(m.Content, map[string]any{"type": "toolCall", "id": callID, "name": name, "arguments": args})
			case "function_call_output", "custom_tool_call_output", "tool_search_output":
				callID := stringField(item, "call_id")
				tool := findToolCall(context.Messages, callID)
				content, isError := normalizeToolOutput(item["output"])
				context.Messages = append(context.Messages, types.Message{Role: "toolResult", ToolCallID: callID, ToolName: tool.Name, Content: mustRaw(content), IsError: isError, Timestamp: now})
			case "agent_message":
				appendMessage("user", normalizeContent(item["content"], false))
			case "compaction", "compaction_summary", "context_compaction":
				if encrypted := stringField(item, "encrypted_content"); encrypted != "" {
					appendMessage("user", "[compacted context: "+encrypted+"]")
				}
			case "additional_tools":
				if tools, ok := item["tools"].([]any); ok {
					context.Tools = append(context.Tools, parseTools(tools)...)
				}
			}
		}
	}
	context.Tools = append(context.Tools, parseToolMaps(data.Tools)...)
	opts := types.RequestOptions{MaxOutputTokens: valueOrZero(data.MaxOutputTokens), Temperature: data.Temperature, TopP: data.TopP, ParallelToolCalls: data.ParallelToolCalls, ServiceTier: data.ServiceTier}
	if data.Stop != nil {
		switch stop := data.Stop.(type) {
		case string:
			opts.StopSequences = []string{stop}
		case []any:
			for _, v := range stop {
				if s, ok := v.(string); ok {
					opts.StopSequences = append(opts.StopSequences, s)
				}
			}
		}
	}
	if data.ToolChoice != nil {
		opts.ToolChoice = mustRaw(data.ToolChoice)
	}
	if effort, _ := data.Reasoning["effort"].(string); effort != "" {
		if effort == "ultra" {
			effort = "max"
		}
		opts.Reasoning = effort
	}
	return &types.NormalizedRequest{ModelID: data.Model, PreviousResponseID: data.PreviousResponseID, Context: context, Stream: data.Stream, Options: opts, RawBody: append(json.RawMessage(nil), raw...)}, nil
}

func ensureAssistant(context *types.RequestContext, now int64) *types.Message {
	if n := len(context.Messages); n > 0 && context.Messages[n-1].Role == "assistant" {
		return &context.Messages[n-1]
	}
	context.Messages = append(context.Messages, types.Message{Role: "assistant", Content: json.RawMessage(`[]`), Timestamp: now})
	return &context.Messages[len(context.Messages)-1]
}
func appendContent(raw json.RawMessage, part any) json.RawMessage {
	var parts []any
	_ = json.Unmarshal(raw, &parts)
	return mustRaw(append(parts, part))
}
func mustRaw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func valueOrZero(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}
func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
func flattenText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	parts, ok := v.([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if m, ok := p.(map[string]any); ok {
			b.WriteString(stringField(m, "text"))
		}
	}
	return b.String()
}
func reasoningText(item map[string]any) string {
	for _, key := range []string{"summary", "content"} {
		if a, ok := item[key].([]any); ok {
			var b strings.Builder
			for _, v := range a {
				if m, ok := v.(map[string]any); ok {
					b.WriteString(stringField(m, "text"))
				}
			}
			if b.Len() > 0 {
				return b.String()
			}
		}
	}
	return ""
}
func normalizeContent(v any, assistant bool) any {
	if v == nil {
		return []any{}
	}
	if _, ok := v.(string); ok {
		return v
	}
	blocks, ok := v.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for _, raw := range blocks {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(m, "type") {
		case "input_text", "output_text", "text":
			out = append(out, map[string]any{"type": "text", "text": stringField(m, "text")})
		case "refusal":
			out = append(out, map[string]any{"type": "text", "text": "[refusal: " + stringField(m, "refusal") + "]"})
		case "input_image":
			if u := stringField(m, "image_url"); u != "" {
				out = append(out, map[string]any{"type": "image", "imageUrl": u, "detail": normalizeDetail(stringField(m, "detail"))})
			}
		case "input_file":
			out = append(out, map[string]any{"type": "text", "text": "[file: " + firstNonEmpty(stringField(m, "file_id"), stringField(m, "filename"), "?") + "]"})
		}
	}
	if len(out) == 1 && !assistant {
		if m := out[0].(map[string]any); m["type"] == "text" {
			return m["text"]
		}
	}
	return out
}
func normalizeDetail(s string) string {
	if s == "original" {
		return "high"
	}
	return s
}
func normalizeToolOutput(v any) (any, bool) {
	if s, ok := v.(string); ok {
		return s, false
	}
	a, ok := v.([]any)
	if !ok {
		return "", false
	}
	out := []any{}
	for _, x := range a {
		m, ok := x.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(m, "type") {
		case "input_image":
			out = append(out, map[string]any{"type": "image", "imageUrl": stringField(m, "image_url"), "detail": normalizeDetail(stringField(m, "detail"))})
		case "encrypted_content":
			out = append(out, map[string]any{"type": "text", "text": "[encrypted content omitted]"})
		default:
			if t := firstNonEmpty(stringField(m, "text"), stringField(m, "refusal")); t != "" {
				out = append(out, map[string]any{"type": "text", "text": t})
			}
		}
	}
	return out, false
}
func parseTools(values []any) []types.Tool {
	maps := []map[string]any{}
	for _, v := range values {
		if m, ok := v.(map[string]any); ok {
			maps = append(maps, m)
		}
	}
	return parseToolMaps(maps)
}
func parseToolMaps(values []map[string]any) []types.Tool {
	out := []types.Tool{}
	seen := map[string]bool{}
	var add func(map[string]any, string)
	add = func(m map[string]any, ns string) {
		t := stringField(m, "type")
		if t == "namespace" {
			if a, ok := m["tools"].([]any); ok {
				for _, v := range a {
					if x, ok := v.(map[string]any); ok {
						add(x, stringField(m, "name"))
					}
				}
			}
			return
		}
		name := stringField(m, "name")
		if t == "tool_search" {
			name = "tool_search"
		}
		if name == "" || seen[ns+"/"+name] || t == "web_search" || t == "image_generation" {
			return
		}
		seen[ns+"/"+name] = true
		p, _ := m["parameters"].(map[string]any)
		out = append(out, types.Tool{Name: name, Description: stringField(m, "description"), Parameters: p, Strict: m["strict"] == true, Namespace: ns})
	}
	for _, m := range values {
		add(m, "")
	}
	return out
}

func findToolCall(messages []types.Message, callID string) types.Tool {
	for i := len(messages) - 1; i >= 0; i-- {
		var parts []map[string]any
		if json.Unmarshal(messages[i].Content, &parts) != nil {
			continue
		}
		for _, part := range parts {
			if stringField(part, "type") == "toolCall" && stringField(part, "id") == callID {
				return types.Tool{Name: stringField(part, "name")}
			}
		}
	}
	return types.Tool{}
}
