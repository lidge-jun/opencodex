package chat

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// RequestError describes a malformed Chat Completions request.
type RequestError struct{ Message string }

func (e *RequestError) Error() string { return e.Message }

type chatRequest struct {
	Model               string            `json:"model"`
	Messages            []json.RawMessage `json:"messages"`
	Tools               []json.RawMessage `json:"tools"`
	ToolChoice          json.RawMessage   `json:"tool_choice"`
	Stream              bool              `json:"stream"`
	MaxCompletionTokens *int              `json:"max_completion_tokens"`
	MaxTokens           *int              `json:"max_tokens"`
	Temperature         *float64          `json:"temperature"`
	TopP                *float64          `json:"top_p"`
	Stop                json.RawMessage   `json:"stop"`
	ParallelToolCalls   *bool             `json:"parallel_tool_calls"`
	ReasoningEffort     string            `json:"reasoning_effort"`
	Reasoning           map[string]any    `json:"reasoning"`
	ServiceTier         string            `json:"service_tier"`
	Metadata            map[string]any    `json:"metadata"`
}

type chatMessageInput struct {
	Role       string            `json:"role"`
	Content    json.RawMessage   `json:"content"`
	ToolCalls  []json.RawMessage `json:"tool_calls"`
	ToolCallID string            `json:"tool_call_id"`
	ToolUseID  string            `json:"tool_use_id"`
}

var reasoningEfforts = map[string]bool{"minimal": true, "low": true, "medium": true, "high": true, "xhigh": true, "max": true, "ultra": true}

// ParseInbound translates an OpenAI Chat Completions body into the canonical request.
func ParseInbound(raw []byte) (*types.NormalizedRequest, error) {
	var body chatRequest
	if len(raw) == 0 || json.Unmarshal(raw, &body) != nil {
		return nil, &RequestError{Message: "request body must be a JSON object"}
	}
	if strings.TrimSpace(body.Model) == "" {
		return nil, &RequestError{Message: "model is required"}
	}
	if len(body.Messages) == 0 {
		return nil, &RequestError{Message: "messages must be a non-empty array"}
	}

	req := &types.NormalizedRequest{ModelID: body.Model, Stream: body.Stream}
	for _, rawMessage := range body.Messages {
		var message chatMessageInput
		if json.Unmarshal(rawMessage, &message) != nil {
			continue
		}
		if err := appendChatMessage(req, message); err != nil {
			return nil, err
		}
	}
	if len(req.Context.Messages) == 0 && len(req.Context.SystemPrompt) == 0 {
		return nil, &RequestError{Message: "messages must include at least one user/assistant/tool turn"}
	}

	tools, err := parseChatTools(body.Tools)
	if err != nil {
		return nil, err
	}
	req.Context.Tools = tools
	req.Options = chatOptions(body)
	req.Metadata = stringMetadata(body.Metadata)
	return req, nil
}

// ChatCompletionsToNormalized is an alias that makes the translation direction explicit.
func ChatCompletionsToNormalized(raw []byte) (*types.NormalizedRequest, error) {
	return ParseInbound(raw)
}

func appendChatMessage(req *types.NormalizedRequest, message chatMessageInput) error {
	switch message.Role {
	case "system", "developer":
		if text := contentText(message.Content); strings.TrimSpace(text) != "" {
			req.Context.SystemPrompt = append(req.Context.SystemPrompt, strings.TrimSpace(text))
		}
	case "user":
		if content := userBlocks(message.Content); len(content) > 0 {
			req.Context.Messages = append(req.Context.Messages, types.Message{Role: "user", Content: mustJSON(content)})
		}
	case "assistant":
		parts := assistantBlocks(message.Content)
		for _, rawCall := range message.ToolCalls {
			call, err := chatToolCallPart(rawCall)
			if err != nil {
				return err
			}
			parts = append(parts, call)
		}
		if len(parts) > 0 {
			req.Context.Messages = append(req.Context.Messages, types.Message{Role: "assistant", Content: mustJSON(parts)})
		}
	case "tool":
		callID := firstNonEmpty(message.ToolCallID, message.ToolUseID)
		if callID == "" {
			return &RequestError{Message: "tool messages require tool_call_id"}
		}
		content := message.Content
		if len(content) == 0 || string(content) == "null" {
			content = json.RawMessage(`""`)
		}
		req.Context.Messages = append(req.Context.Messages, types.Message{Role: "toolResult", Content: content, ToolCallID: callID})
	}
	return nil
}

func userBlocks(raw json.RawMessage) []map[string]any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	if text, ok := value.(string); ok {
		if text == "" {
			return nil
		}
		return []map[string]any{{"type": "input_text", "text": text}}
	}
	parts, _ := value.([]any)
	out := make([]map[string]any, 0, len(parts))
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		switch part["type"] {
		case "text", "input_text":
			if text, ok := part["text"].(string); ok {
				out = append(out, map[string]any{"type": "input_text", "text": text})
			}
		case "image_url":
			if url := imageURL(part["image_url"]); url != "" {
				out = append(out, map[string]any{"type": "input_image", "image_url": url})
			}
		}
	}
	return out
}

func assistantBlocks(raw json.RawMessage) []map[string]any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	if text, ok := value.(string); ok {
		if text == "" {
			return nil
		}
		return []map[string]any{{"type": "output_text", "text": text}}
	}
	parts, _ := value.([]any)
	out := make([]map[string]any, 0, len(parts))
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if part["type"] == "text" || part["type"] == "output_text" {
			if text, ok := part["text"].(string); ok {
				out = append(out, map[string]any{"type": "output_text", "text": text})
			}
		}
	}
	return out
}

func chatToolCallPart(raw json.RawMessage) (map[string]any, error) {
	var call map[string]any
	if json.Unmarshal(raw, &call) != nil {
		return nil, &RequestError{Message: "tool_calls entries must be objects"}
	}
	fn, _ := call["function"].(map[string]any)
	name, _ := fn["name"].(string)
	if name == "" {
		name, _ = call["name"].(string)
	}
	id, _ := call["id"].(string)
	if id == "" {
		id, _ = call["call_id"].(string)
	}
	if id == "" {
		id = "call_" + randomHex(12)
	}
	if name == "" {
		return nil, &RequestError{Message: "tool_calls entries require function.name"}
	}
	arguments := fn["arguments"]
	if arguments == nil {
		arguments = call["arguments"]
	}
	arguments = decodeArguments(arguments)
	return map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": arguments}, nil
}

func parseChatTools(rawTools []json.RawMessage) ([]types.Tool, error) {
	out := make([]types.Tool, 0, len(rawTools))
	for _, raw := range rawTools {
		var entry map[string]any
		if json.Unmarshal(raw, &entry) != nil {
			continue
		}
		fn := entry
		if nested, ok := entry["function"].(map[string]any); ok {
			fn = nested
		}
		name, _ := fn["name"].(string)
		if entry["type"] != "function" || name == "" {
			continue
		}
		parameters, _ := fn["parameters"].(map[string]any)
		description, _ := fn["description"].(string)
		strict, _ := fn["strict"].(bool)
		out = append(out, types.Tool{Name: name, Description: description, Parameters: parameters, Strict: strict})
	}
	return out, nil
}

func chatOptions(body chatRequest) types.RequestOptions {
	options := types.RequestOptions{Temperature: body.Temperature, TopP: body.TopP, ParallelToolCalls: body.ParallelToolCalls, ServiceTier: body.ServiceTier}
	if body.MaxCompletionTokens != nil {
		options.MaxOutputTokens = *body.MaxCompletionTokens
	} else if body.MaxTokens != nil {
		options.MaxOutputTokens = *body.MaxTokens
	}
	if len(body.Stop) > 0 && string(body.Stop) != "null" {
		var many []string
		if json.Unmarshal(body.Stop, &many) == nil {
			options.StopSequences = many
		} else {
			var one string
			if json.Unmarshal(body.Stop, &one) == nil {
				options.StopSequences = []string{one}
			}
		}
	}
	if len(body.ToolChoice) > 0 && string(body.ToolChoice) != "null" {
		options.ToolChoice = normalizeToolChoice(body.ToolChoice)
	}
	options.Reasoning = body.ReasoningEffort
	if !reasoningEfforts[options.Reasoning] {
		options.Reasoning = ""
	}
	if options.Reasoning == "" {
		if effort, ok := body.Reasoning["effort"].(string); ok {
			if reasoningEfforts[effort] {
				options.Reasoning = effort
			}
		}
	}
	return options
}

func normalizeToolChoice(raw json.RawMessage) json.RawMessage {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	entry, ok := value.(map[string]any)
	if !ok {
		return append(json.RawMessage(nil), raw...)
	}
	if fn, ok := entry["function"].(map[string]any); ok {
		if name, ok := fn["name"].(string); ok {
			return mustJSON(map[string]any{"type": "function", "name": name})
		}
	}
	return append(json.RawMessage(nil), raw...)
}

func contentText(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	parts, _ := value.([]any)
	var out []string
	for _, value := range parts {
		if text, ok := value.(string); ok {
			out = append(out, text)
			continue
		}
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := part["type"].(string)
		if kind == "text" || kind == "input_text" || kind == "output_text" {
			if text, ok := part["text"].(string); ok {
				out = append(out, text)
			}
		}
	}
	return strings.Join(out, "\n")
}

func imageURL(value any) string {
	if url, ok := value.(string); ok {
		return url
	}
	if rec, ok := value.(map[string]any); ok {
		if url, ok := rec["url"].(string); ok {
			return url
		}
	}
	return ""
}

func decodeArguments(value any) any {
	text, ok := value.(string)
	if !ok {
		if value == nil {
			return map[string]any{}
		}
		return value
	}
	var decoded any
	if json.Unmarshal([]byte(text), &decoded) == nil {
		return decoded
	}
	return map[string]any{}
}

func stringMetadata(metadata map[string]any) map[string]string {
	out := make(map[string]string)
	for key, value := range metadata {
		if text, ok := value.(string); ok {
			out[key] = text
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func mustJSON(value any) json.RawMessage { data, _ := json.Marshal(value); return data }
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
func randomHex(bytes int) string {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		return fmt.Sprintf("%024x", bytes)
	}
	return hex.EncodeToString(data)
}
