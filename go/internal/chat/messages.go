package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type MessagesHandler struct{ config HandlerConfig }

var _ types.RouteHandler = (*MessagesHandler)(nil)

func NewMessagesHandler(config HandlerConfig) *MessagesHandler {
	return &MessagesHandler{config: withHandlerDefaults(config)}
}

func (h *MessagesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	raw, err := readRequestBody(w, r, h.config.BodyLimit)
	if err != nil {
		writeAnthropicError(w, 400, err.Error())
		return
	}
	normalized, requestedModel, err := parseAnthropicInbound(raw)
	if err != nil {
		writeAnthropicError(w, 400, err.Error())
		return
	}
	prepared, err := h.config.prepare(r.Context(), r.Header, normalized)
	if err != nil {
		writeAnthropicErrorFor(w, err)
		return
	}
	if h.shouldPassthrough(prepared.resolved) {
		h.nativePassthrough(w, r, raw, prepared)
		return
	}
	response, err := h.config.do(r.Context(), prepared)
	if err != nil {
		writeAnthropicErrorFor(w, err)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		message := readProviderError(response.Body, h.config.ResponseLimit)
		if message == "" {
			message = fmt.Sprintf("upstream error (%d)", response.StatusCode)
		}
		writeAnthropicError(w, response.StatusCode, message)
		return
	}
	if normalized.Stream {
		_ = writeAnthropicStream(r.Context(), w, requestedModel, prepared.adapter.ParseStream(r.Context(), response.Body))
		return
	}
	defer response.Body.Close()
	payload, err := readBounded(response.Body, h.config.ResponseLimit)
	if err != nil {
		writeAnthropicError(w, 502, err.Error())
		return
	}
	events, err := prepared.adapter.ParseUnary(r.Context(), payload)
	if err != nil {
		writeAnthropicError(w, 502, err.Error())
		return
	}
	message, err := buildAnthropicMessage(events, requestedModel)
	if err != nil {
		writeAnthropicError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, message)
}

type anthropicRequest struct {
	Model         string            `json:"model"`
	Messages      []json.RawMessage `json:"messages"`
	System        json.RawMessage   `json:"system"`
	Tools         []json.RawMessage `json:"tools"`
	ToolChoice    json.RawMessage   `json:"tool_choice"`
	Stream        bool              `json:"stream"`
	MaxTokens     int               `json:"max_tokens"`
	Temperature   *float64          `json:"temperature"`
	TopP          *float64          `json:"top_p"`
	StopSequences []string          `json:"stop_sequences"`
	Thinking      map[string]any    `json:"thinking"`
	OutputConfig  map[string]any    `json:"output_config"`
	Metadata      map[string]any    `json:"metadata"`
}

func parseAnthropicInbound(raw []byte) (*types.NormalizedRequest, string, error) {
	var body anthropicRequest
	if json.Unmarshal(raw, &body) != nil {
		return nil, "", &RequestError{Message: "request body must be a JSON object"}
	}
	if strings.TrimSpace(body.Model) == "" {
		return nil, "", &RequestError{Message: "model is required"}
	}
	if len(body.Messages) == 0 {
		return nil, "", &RequestError{Message: "messages must be a non-empty array"}
	}
	req := &types.NormalizedRequest{ModelID: body.Model, Stream: body.Stream}
	if system := contentText(body.System); system != "" {
		req.Context.SystemPrompt = append(req.Context.SystemPrompt, system)
	}
	for _, rawMessage := range body.Messages {
		var message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(rawMessage, &message) != nil {
			return nil, "", &RequestError{Message: "each message must be an object"}
		}
		switch message.Role {
		case "system":
			if text := contentText(message.Content); text != "" {
				req.Context.SystemPrompt = append(req.Context.SystemPrompt, text)
			}
		case "user":
			if err := appendAnthropicUser(&req.Context.Messages, message.Content); err != nil {
				return nil, "", err
			}
		case "assistant":
			if err := appendAnthropicAssistant(&req.Context.Messages, message.Content); err != nil {
				return nil, "", err
			}
		default:
			return nil, "", &RequestError{Message: "unsupported message role: " + message.Role}
		}
	}
	req.Context.Tools = anthropicTools(body.Tools)
	req.Options = types.RequestOptions{MaxOutputTokens: body.MaxTokens, Temperature: body.Temperature, TopP: body.TopP, StopSequences: body.StopSequences}
	applyAnthropicToolChoice(&req.Options, body.ToolChoice)
	thinkingDisabled := body.Thinking["type"] == "disabled"
	if effort, ok := body.OutputConfig["effort"].(string); !thinkingDisabled && ok && reasoningEfforts[effort] {
		req.Options.Reasoning = effort
	}
	if !thinkingDisabled && req.Options.Reasoning == "" && body.Thinking["type"] == "enabled" {
		if budget, ok := body.Thinking["budget_tokens"].(float64); ok {
			req.Options.Reasoning = effortForBudget(int(budget))
		}
	}
	if userID, ok := body.Metadata["user_id"].(string); ok {
		req.Metadata = map[string]string{"user_id": userID}
	}
	return req, body.Model, nil
}

func appendAnthropicUser(messages *[]types.Message, raw json.RawMessage) error {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return &RequestError{Message: "invalid user content"}
	}
	if text, ok := value.(string); ok {
		if text != "" {
			*messages = append(*messages, types.Message{Role: "user", Content: mustJSON([]any{map[string]any{"type": "input_text", "text": text}})})
		}
		return nil
	}
	parts, ok := value.([]any)
	if !ok {
		return nil
	}
	pending := make([]any, 0)
	flush := func() {
		if len(pending) > 0 {
			*messages = append(*messages, types.Message{Role: "user", Content: mustJSON(pending)})
			pending = nil
		}
	}
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		switch part["type"] {
		case "text":
			if text, ok := part["text"].(string); ok {
				pending = append(pending, map[string]any{"type": "input_text", "text": text})
			}
		case "image":
			if image := anthropicImage(part); image != nil {
				pending = append(pending, image)
			}
		case "tool_result":
			flush()
			id, _ := part["tool_use_id"].(string)
			if id == "" {
				return &RequestError{Message: "tool_result requires tool_use_id"}
			}
			content := anthropicToolOutput(part)
			*messages = append(*messages, types.Message{Role: "toolResult", Content: mustJSON(content), ToolCallID: id, IsError: part["is_error"] == true})
		case "document":
			if title, _ := part["title"].(string); title != "" {
				pending = append(pending, map[string]any{"type": "input_text", "text": "[document: " + title + "]"})
			}
		}
	}
	flush()
	return nil
}

func appendAnthropicAssistant(messages *[]types.Message, raw json.RawMessage) error {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return &RequestError{Message: "invalid assistant content"}
	}
	if text, ok := value.(string); ok {
		if text != "" {
			*messages = append(*messages, types.Message{Role: "assistant", Content: mustJSON([]any{map[string]any{"type": "output_text", "text": text}})})
		}
		return nil
	}
	parts, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(parts))
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		switch part["type"] {
		case "text":
			if text, ok := part["text"].(string); ok {
				out = append(out, map[string]any{"type": "output_text", "text": text})
			}
		case "tool_use":
			id, _ := part["id"].(string)
			name, _ := part["name"].(string)
			if id == "" || name == "" {
				return &RequestError{Message: "tool_use requires id and name"}
			}
			out = append(out, map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": part["input"]})
		}
	}
	if len(out) > 0 {
		*messages = append(*messages, types.Message{Role: "assistant", Content: mustJSON(out)})
	}
	return nil
}

func anthropicTools(rawTools []json.RawMessage) []types.Tool {
	out := make([]types.Tool, 0, len(rawTools))
	for _, raw := range rawTools {
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			continue
		}
		name, _ := value["name"].(string)
		schema, _ := value["input_schema"].(map[string]any)
		if name == "" || schema == nil {
			continue
		}
		description, _ := value["description"].(string)
		out = append(out, types.Tool{Name: name, Description: description, Parameters: schema})
	}
	return out
}

func applyAnthropicToolChoice(options *types.RequestOptions, raw json.RawMessage) {
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return
	}
	if value["disable_parallel_tool_use"] == true {
		disabled := false
		options.ParallelToolCalls = &disabled
	}
	switch value["type"] {
	case "auto":
		options.ToolChoice = json.RawMessage(`"auto"`)
	case "none":
		options.ToolChoice = json.RawMessage(`"none"`)
	case "any":
		options.ToolChoice = json.RawMessage(`"required"`)
	case "tool":
		if name, ok := value["name"].(string); ok {
			options.ToolChoice = mustJSON(map[string]any{"type": "function", "name": name})
		}
	}
}

func anthropicImage(part map[string]any) map[string]any {
	source, _ := part["source"].(map[string]any)
	kind, _ := source["type"].(string)
	if kind == "url" {
		if value, ok := source["url"].(string); ok {
			return map[string]any{"type": "input_image", "image_url": value}
		}
	}
	if kind == "base64" {
		data, _ := source["data"].(string)
		media, _ := source["media_type"].(string)
		if media == "" {
			media = "image/png"
		}
		if data != "" {
			return map[string]any{"type": "input_image", "image_url": "data:" + media + ";base64," + data}
		}
	}
	return nil
}

func anthropicToolOutput(part map[string]any) any {
	content := part["content"]
	if text, ok := content.(string); ok {
		if part["is_error"] == true {
			return "[tool error] " + text
		}
		return text
	}
	if blocks, ok := content.([]any); ok {
		return blocks
	}
	if part["is_error"] == true {
		return "[tool error]"
	}
	return ""
}

func effortForBudget(budget int) string {
	if budget <= 4096 {
		return "low"
	}
	if budget <= 16384 {
		return "medium"
	}
	return "high"
}
