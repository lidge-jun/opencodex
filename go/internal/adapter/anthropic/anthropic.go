package anthropic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	defaultMaxTokens             = 8192
	reasoningMaxTokensCeiling    = 32000
	adaptiveThinkingCeiling      = 40192
	minimumThinkingBudget        = 1024
	thinkingOutputHeadroom       = 8192
	minimumThinkingOutputReserve = 4096
)

var anthropicModelFamilyPattern = regexp.MustCompile(`^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?:\D|$))?`)

type Adapter struct {
	BaseURL string
	Client  *http.Client
	APIKey  string
	Headers map[string]string
}

var _ types.Adapter = (*Adapter)(nil)

func (a *Adapter) HTTPClient() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return http.DefaultClient
}

func (a *Adapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if req == nil {
		return nil, fmt.Errorf("build Anthropic request: nil normalized request")
	}
	endpoint, err := messagesEndpoint(a.BaseURL)
	if err != nil {
		return nil, err
	}
	body, err := anthropicRequestBody(req)
	if err != nil {
		return nil, fmt.Errorf("build Anthropic request body: %w", err)
	}
	messages := body["messages"].([]any)
	if err := NormalizeAnthropicImages(messages); err != nil {
		return nil, fmt.Errorf("normalize Anthropic images: %w", err)
	}
	EnforceAnthropicImageLimits(messages)
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal Anthropic request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build Anthropic request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	if req.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	if strings.TrimSpace(a.APIKey) != "" {
		httpReq.Header.Set("x-api-key", strings.TrimSpace(a.APIKey))
	}
	for key, value := range a.Headers {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			httpReq.Header.Set(key, value)
		}
	}
	return httpReq, nil
}

func messagesEndpoint(baseURL string) (string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "https://api.anthropic.com"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid Anthropic base URL %q", baseURL)
	}
	if strings.HasSuffix(baseURL, "/v1/messages") {
		return baseURL, nil
	}
	baseURL = strings.TrimSuffix(baseURL, "/v1")
	return baseURL + "/v1/messages", nil
}

func anthropicRequestBody(req *types.NormalizedRequest) (map[string]any, error) {
	messages, err := messagesToAnthropic(req.Context.Messages)
	if err != nil {
		return nil, err
	}
	maxTokens := req.Options.MaxOutputTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}
	body := map[string]any{
		"model": req.ModelID, "messages": messages, "stream": req.Stream, "max_tokens": maxTokens,
	}
	if len(req.Context.SystemPrompt) > 0 {
		body["system"] = []any{map[string]any{"type": "text", "text": strings.Join(req.Context.SystemPrompt, "\n\n")}}
	}
	if len(req.Context.Tools) > 0 {
		body["tools"] = anthropicTools(req.Context.Tools)
	}
	if req.Options.Temperature != nil {
		body["temperature"] = *req.Options.Temperature
	}
	if req.Options.TopP != nil {
		body["top_p"] = *req.Options.TopP
	}
	if len(req.Options.StopSequences) > 0 {
		body["stop_sequences"] = req.Options.StopSequences
	}
	applyToolChoice(body, req.Options.ToolChoice)
	applyThinking(body, req.Options.Reasoning, req.Options.MaxOutputTokens)
	return body, nil
}

func messagesToAnthropic(messages []types.Message) ([]any, error) {
	out := make([]any, 0, len(messages)+1)
	for index := 0; index < len(messages); index++ {
		message := messages[index]
		switch message.Role {
		case "user", "developer":
			content, err := userContent(message.Content, "(empty)")
			if err != nil {
				return nil, fmt.Errorf("decode %s message content: %w", message.Role, err)
			}
			out = append(out, map[string]any{"role": "user", "content": content})
		case "assistant":
			content, toolIDs, err := assistantContent(message.Content)
			if err != nil {
				return nil, fmt.Errorf("decode assistant message content: %w", err)
			}
			if len(content) == 0 {
				continue
			}
			out = append(out, map[string]any{"role": "assistant", "content": content})
			if len(toolIDs) > 0 {
				results := make([]any, 0, len(toolIDs))
				seen := make(map[string]bool)
				for index+1 < len(messages) && (messages[index+1].Role == "toolResult" || messages[index+1].Role == "tool") {
					index++
					result := messages[index]
					if containsString(toolIDs, result.ToolCallID) && !seen[result.ToolCallID] {
						block, err := toolResultBlock(result)
						if err != nil {
							return nil, err
						}
						results = append(results, block)
						seen[result.ToolCallID] = true
					} else {
						results = append(results, map[string]any{"type": "text", "text": orphanToolResult(result)})
					}
				}
				for _, id := range toolIDs {
					if !seen[id] {
						results = append(results, map[string]any{"type": "tool_result", "tool_use_id": id, "content": "[missing tool_result for this tool_use in history]", "is_error": true})
					}
				}
				out = append(out, map[string]any{"role": "user", "content": results})
			}
		case "toolResult", "tool":
			out = append(out, map[string]any{"role": "user", "content": orphanToolResult(message)})
		}
	}
	if len(out) == 0 || out[len(out)-1].(map[string]any)["role"] == "assistant" {
		out = append(out, map[string]any{"role": "user", "content": "(continue)"})
	}
	return out, nil
}

func userContent(raw json.RawMessage, empty string) (any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	if text, ok := value.(string); ok {
		if text == "" {
			return empty, nil
		}
		return text, nil
	}
	parts, ok := value.([]any)
	if !ok {
		return empty, nil
	}
	out := make([]any, 0, len(parts))
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		switch part["type"] {
		case "text", "input_text":
			text := firstString(part, "text", "input_text")
			if text != "" {
				out = append(out, map[string]any{"type": "text", "text": text})
			}
		case "image", "input_image":
			imageURL := firstString(part, "imageUrl", "image_url")
			out = append(out, anthropicImageBlock(imageURL))
		}
	}
	if len(out) == 0 {
		return empty, nil
	}
	return out, nil
}

func anthropicImageBlock(imageURL string) map[string]any {
	if strings.HasPrefix(imageURL, "data:") {
		if comma := strings.IndexByte(imageURL, ','); comma > 5 && strings.Contains(strings.ToLower(imageURL[:comma]), ";base64") {
			media := strings.TrimPrefix(strings.Split(imageURL[:comma], ";")[0], "data:")
			return map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": media, "data": imageURL[comma+1:]}}
		}
	}
	return map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": imageURL}}
}

func assistantContent(raw json.RawMessage) ([]any, []string, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, nil, err
	}
	parts, ok := value.([]any)
	if !ok {
		if text, ok := value.(string); ok && text != "" {
			return []any{map[string]any{"type": "text", "text": text}}, nil, nil
		}
		return nil, nil, nil
	}
	out := make([]any, 0, len(parts))
	toolIDs := make([]string, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		switch part["type"] {
		case "text", "output_text":
			if text := firstString(part, "text", "output_text"); text != "" {
				out = append(out, map[string]any{"type": "text", "text": text})
			}
		case "thinking", "reasoning":
			if thinking := firstString(part, "thinking", "reasoning", "text"); thinking != "" {
				block := map[string]any{"type": "thinking", "thinking": thinking}
				if signature, _ := part["signature"].(string); signature != "" {
					block["signature"] = signature
				}
				out = append(out, block)
			}
		case "toolCall", "tool_call":
			id := firstString(part, "id", "call_id")
			name := firstString(part, "name")
			if namespace, _ := part["namespace"].(string); namespace != "" {
				name = namespace + "." + name
			}
			input := part["arguments"]
			if input == nil {
				input = map[string]any{}
			}
			out = append(out, map[string]any{"type": "tool_use", "id": id, "name": name, "input": input})
			toolIDs = append(toolIDs, id)
		}
	}
	return out, toolIDs, nil
}

func toolResultBlock(message types.Message) (map[string]any, error) {
	content, err := userContent(message.Content, "(empty tool output)")
	if err != nil {
		return nil, fmt.Errorf("decode tool result content: %w", err)
	}
	block := map[string]any{"type": "tool_result", "tool_use_id": message.ToolCallID, "content": content}
	if message.IsError {
		block["is_error"] = true
	}
	return block, nil
}

func orphanToolResult(message types.Message) string {
	label := message.ToolCallID
	if message.ToolName != "" {
		label = message.ToolName + " (" + message.ToolCallID + ")"
	}
	return fmt.Sprintf("[tool_result without adjacent tool_use: %s]\n%s", label, string(message.Content))
}

func anthropicTools(tools []types.Tool) []any {
	out := make([]any, 0, len(tools))
	for _, tool := range tools {
		name := tool.Name
		if tool.Namespace != "" {
			name = tool.Namespace + "." + name
		}
		schema := make(map[string]any, len(tool.Parameters)+2)
		for key, value := range tool.Parameters {
			schema[key] = value
		}
		if schema["type"] != "object" {
			schema["type"] = "object"
		}
		if schema["properties"] == nil {
			schema["properties"] = map[string]any{}
		}
		out = append(out, map[string]any{"name": name, "description": tool.Description, "input_schema": schema})
	}
	return out
}

func applyToolChoice(body map[string]any, raw json.RawMessage) {
	if len(raw) == 0 || !json.Valid(raw) {
		return
	}
	var choice any
	if json.Unmarshal(raw, &choice) != nil {
		return
	}
	switch value := choice.(type) {
	case string:
		typesByName := map[string]string{"auto": "auto", "none": "none", "required": "any"}
		if mapped := typesByName[value]; mapped != "" {
			body["tool_choice"] = map[string]any{"type": mapped}
		}
	case map[string]any:
		if name, _ := value["name"].(string); name != "" {
			body["tool_choice"] = map[string]any{"type": "tool", "name": name}
		}
	}
}

func applyThinking(body map[string]any, effort string, explicitMax int) {
	if effort == "" || effort == "none" {
		return
	}
	budget := map[string]int{"minimal": 1024, "low": 2048, "medium": 8192, "high": 16384, "xhigh": 24576, "max": 32000}[effort]
	if budget == 0 {
		budget = 8192
	}
	model, _ := body["model"].(string)
	if usesAdaptiveThinking(model) {
		adaptiveEffort := effort
		if adaptiveEffort == "minimal" {
			adaptiveEffort = "low"
		}
		body["thinking"] = map[string]any{"type": "adaptive"}
		body["output_config"] = map[string]any{"effort": adaptiveEffort}
		if explicitMax > 0 {
			body["max_tokens"] = explicitMax
		} else {
			body["max_tokens"] = min(adaptiveThinkingCeiling, max(defaultMaxTokens, budget+thinkingOutputHeadroom))
		}
		delete(body, "temperature")
		delete(body, "top_p")
		return
	}
	maxTokens := explicitMax
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}
	maxTokens = min(reasoningMaxTokensCeiling, max(maxTokens, budget+thinkingOutputHeadroom))
	budget = max(minimumThinkingBudget, min(budget, maxTokens-minimumThinkingOutputReserve))
	body["max_tokens"] = maxTokens
	body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
	delete(body, "temperature")
	delete(body, "top_p")
}

func usesAdaptiveThinking(model string) bool {
	match := anthropicModelFamilyPattern.FindStringSubmatch(model)
	if match == nil {
		return false
	}
	major, _ := strconv.Atoi(match[2])
	minor, _ := strconv.Atoi(match[3])
	switch match[1] {
	case "fable":
		return true
	case "sonnet":
		return major >= 5
	case "opus":
		return major > 4 || major == 4 && minor >= 7
	default:
		return false
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func firstString(value map[string]any, keys ...string) string {
	for _, key := range keys {
		if text, ok := value[key].(string); ok {
			return text
		}
	}
	return ""
}

type pendingTool struct {
	id        string
	name      string
	arguments strings.Builder
}

func (a *Adapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		blocks := make(map[int]*pendingTool)
		blockTypes := make(map[int]string)
		var usage map[string]int
		stopReason := ""
		terminal := false
		for frame := range decodeSSE(ctx, body) {
			var event map[string]any
			if json.Unmarshal([]byte(frame.Data), &event) != nil {
				emit(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "malformed upstream SSE data frame"})
				return
			}
			eventType := frame.Event
			if eventType == "" {
				eventType, _ = event["type"].(string)
			}
			switch eventType {
			case "message_start":
				message, _ := event["message"].(map[string]any)
				usage = mergeUsage(usage, message["usage"])
			case "content_block_start":
				index := intValue(event["index"])
				block, _ := event["content_block"].(map[string]any)
				blockType, _ := block["type"].(string)
				blockTypes[index] = blockType
				if blockType == "tool_use" {
					pending := &pendingTool{id: firstString(block, "id"), name: firstString(block, "name")}
					if input := block["input"]; input != nil {
						if encoded, err := json.Marshal(input); err == nil && string(encoded) != "{}" {
							pending.arguments.Write(encoded)
						}
					}
					blocks[index] = pending
				}
			case "content_block_delta":
				index := intValue(event["index"])
				delta, _ := event["delta"].(map[string]any)
				switch delta["type"] {
				case "text_delta":
					emit(ctx, out, types.AdapterEvent{Type: types.EventTextDelta, Text: firstString(delta, "text")})
				case "thinking_delta", "reasoning_delta":
					emit(ctx, out, types.AdapterEvent{Type: types.EventReasoning, Reasoning: firstString(delta, "thinking", "reasoning")})
				case "input_json_delta":
					if pending := blocks[index]; pending != nil {
						pending.arguments.WriteString(firstString(delta, "partial_json"))
					}
				}
			case "content_block_stop":
				index := intValue(event["index"])
				if blockTypes[index] == "tool_use" {
					if pending := blocks[index]; pending != nil {
						arguments := []byte(pending.arguments.String())
						if !json.Valid(arguments) {
							arguments = []byte("{}")
						}
						emit(ctx, out, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: pending.id, Name: pending.name, Arguments: arguments}})
					}
				}
				delete(blocks, index)
				delete(blockTypes, index)
			case "message_delta":
				usage = mergeUsage(usage, event["usage"])
				delta, _ := event["delta"].(map[string]any)
				stopReason = firstString(delta, "stop_reason")
			case "message_stop":
				emit(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: anthropicUsage(usage), StopReason: stopReason})
				terminal = true
				return
			case "error":
				errorValue, _ := event["error"].(map[string]any)
				emit(ctx, out, types.AdapterEvent{Type: types.EventError, Error: firstNonEmpty(firstString(errorValue, "message"), "Anthropic error")})
				return
			}
		}
		if ctx.Err() == nil && !terminal {
			if usage != nil {
				emit(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: anthropicUsage(usage), StopReason: stopReason})
			} else {
				emit(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "upstream stream ended without a terminal signal"})
			}
		}
	}()
	return out
}

func (a *Adapter) ParseUnary(_ context.Context, body []byte) ([]types.AdapterEvent, error) {
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("parse Anthropic response: %w", err)
	}
	if errorValue, ok := response["error"].(map[string]any); ok {
		return []types.AdapterEvent{{Type: types.EventError, Error: firstNonEmpty(firstString(errorValue, "message"), "Anthropic error")}}, nil
	}
	events := make([]types.AdapterEvent, 0)
	for _, raw := range sliceValue(response["content"]) {
		block, _ := raw.(map[string]any)
		switch block["type"] {
		case "text":
			if text := firstString(block, "text"); text != "" {
				events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
		case "thinking", "reasoning":
			events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: firstString(block, "thinking", "reasoning")})
		case "tool_use":
			arguments, _ := json.Marshal(block["input"])
			if !json.Valid(arguments) {
				arguments = []byte("{}")
			}
			events = append(events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: firstString(block, "id"), Name: firstString(block, "name"), Arguments: arguments}})
		}
	}
	events = append(events, types.AdapterEvent{Type: types.EventDone, Usage: anthropicUsage(mergeUsage(nil, response["usage"])), StopReason: firstString(response, "stop_reason")})
	return events, nil
}

func decodeSSE(ctx context.Context, body io.ReadCloser) <-chan protocol.SSEEvent {
	out := make(chan protocol.SSEEvent)
	if body == nil {
		close(out)
		return out
	}
	go func() {
		defer close(out)
		defer body.Close()
		decoded := make(chan protocol.SSEEvent)
		decoder := protocol.NewSSEDecoder(decoded)
		go func() {
			_, _ = io.Copy(decoder, body)
			_ = decoder.Close()
			close(decoded)
		}()
		for event := range decoded {
			select {
			case out <- event:
			case <-ctx.Done():
				_ = body.Close()
				for range decoded {
				}
				return
			}
		}
	}()
	return out
}

func emit(ctx context.Context, out chan<- types.AdapterEvent, event types.AdapterEvent) bool {
	select {
	case out <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func mergeUsage(base map[string]int, value any) map[string]int {
	usage, ok := value.(map[string]any)
	if !ok {
		return base
	}
	if base == nil {
		base = make(map[string]int)
	}
	for _, key := range []string{"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"} {
		if usage[key] != nil {
			base[key] = intValue(usage[key])
		}
	}
	return base
}

func anthropicUsage(usage map[string]int) *types.Usage {
	if usage == nil {
		return nil
	}
	read, write := usage["cache_read_input_tokens"], usage["cache_creation_input_tokens"]
	input, output := usage["input_tokens"]+read+write, usage["output_tokens"]
	return &types.Usage{
		InputTokens: input, OutputTokens: output, TotalTokens: input + output,
		CachedInputTokens: read, CacheReadInputTokens: read, CacheCreationInputTokens: write,
	}
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case json.Number:
		value, _ := number.Int64()
		return int(value)
	default:
		return 0
	}
}

func sliceValue(value any) []any {
	items, _ := value.([]any)
	return items
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
