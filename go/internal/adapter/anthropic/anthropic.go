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

	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
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
	BaseURL        string
	Client         *http.Client
	APIKey         string
	Headers        map[string]string
	Provider       config.ProviderConfig
	CacheRetention string
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
	provider := a.providerConfig()
	apiKey := strings.TrimSpace(a.APIKey)
	if apiKey == "" {
		if provider.AuthMode == "oauth" {
			return nil, fmt.Errorf("anthropic oauth token missing — run ocx login anthropic")
		}
		return nil, fmt.Errorf("anthropic provider requires a non-empty apiKey (authMode: key)")
	}
	endpoint, err := messagesEndpoint(provider.BaseURL)
	if err != nil {
		return nil, err
	}
	body, err := anthropicRequestBodyForAdapter(req, provider)
	if err != nil {
		return nil, fmt.Errorf("build Anthropic request body: %w", err)
	}
	messages := body["messages"].([]any)
	if err := NormalizeAnthropicImages(messages); err != nil {
		return nil, fmt.Errorf("normalize Anthropic images: %w", err)
	}
	EnforceAnthropicImageLimits(messages)
	control := resolveCacheControl(a.CacheRetention)
	automatic, err := usesNativeAnthropicEndpoint(provider.BaseURL)
	if err != nil {
		return nil, err
	}
	automatic = automatic && control != nil
	explicitLimit := maxCacheBreakpoints
	if automatic {
		body["cache_control"] = cloneAnyMap(control)
		explicitLimit--
	}
	applyPromptCaching(body, control, explicitLimit, automatic)
	enforceCacheControlLimit(body, explicitLimit)
	normalizeCacheTTLOrdering(body)
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
	httpReq.Header.Set("User-Agent", "@anthropic-ai/sdk/0.74.0")
	if req.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	if provider.AuthMode == "oauth" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
		httpReq.Header.Set("anthropic-beta", AnthropicOAuthBeta)
		for key, value := range openaiadapter.ClaudeCodeHeaders() {
			httpReq.Header.Set(key, value)
		}
		httpReq.Header.Set("X-Claude-Code-Session-Id", openaiadapter.ClaudeCodeSessionID(apiKey))
		httpReq.Header.Set("x-client-request-id", newRequestID())
	} else {
		// apiKeyTransport picks WHICH header carries the key. Exactly one is
		// ever set: sending both would put the same credential in two places,
		// and some gateways treat the presence of Authorization as a different
		// auth scheme entirely.
		//
		// The default is x-api-key, which is what Anthropic itself expects;
		// "bearer" exists for gateways that only read Authorization.
		if provider.APIKeyTransport == "bearer" {
			httpReq.Header.Set("Authorization", "Bearer "+apiKey)
		} else {
			httpReq.Header.Set("x-api-key", apiKey)
		}
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
	if start := strings.IndexByte(baseURL, '{'); start >= 0 {
		end := strings.IndexByte(baseURL[start:], '}')
		placeholder := baseURL[start:]
		if end >= 0 {
			placeholder = baseURL[start : start+end+1]
		}
		return "", fmt.Errorf("anthropic provider baseUrl contains unresolved %s", placeholder)
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
	adapter := &Adapter{APIKey: "compat"}
	return anthropicRequestBodyForAdapter(req, adapter.providerConfig())
}

func anthropicRequestBodyForAdapter(req *types.NormalizedRequest, provider config.ProviderConfig) (map[string]any, error) {
	names := buildToolNameTransforms(provider)
	messages, err := messagesToAnthropic(req.Context.Messages, names)
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
	choice := parseAnthropicToolChoice(req.Options.ToolChoice)
	visibleTools := filterAnthropicTools(req.Context.Tools, choice)
	system := anthropicSystemText(req, visibleTools, names)
	if provider.AuthMode == "oauth" {
		blocks := []any{map[string]any{"type": "text", "text": ClaudeCodeSystemInstruction}}
		if system != "" {
			blocks = append(blocks, map[string]any{"type": "text", "text": system})
		}
		body["system"] = blocks
	} else if system != "" {
		body["system"] = []any{map[string]any{"type": "text", "text": system}}
	}
	if len(visibleTools) > 0 {
		body["tools"] = anthropicTools(visibleTools, names)
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
	applyToolChoice(body, choice, visibleTools, names)
	applyThinking(body, req.Options.Reasoning, req.Options.MaxOutputTokens)
	return body, nil
}

func messagesToAnthropic(messages []types.Message, names toolNameTransforms) ([]any, error) {
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
			content, toolIDs, err := assistantContent(message.Content, names)
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

func assistantContent(raw json.RawMessage, names toolNameTransforms) ([]any, []string, error) {
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
	preface := make([]any, 0, len(parts))
	toolUses := make([]any, 0)
	toolIDs := make([]string, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		switch part["type"] {
		case "text", "output_text":
			if text := firstString(part, "text", "output_text"); text != "" {
				preface = append(preface, map[string]any{"type": "text", "text": text})
			}
		case "thinking", "reasoning":
			for _, data := range stringItems(part["redacted"]) {
				preface = append(preface, map[string]any{"type": "redacted_thinking", "data": data})
			}
			if thinking := firstString(part, "thinking", "reasoning", "text"); thinking != "" {
				if signature, _ := part["signature"].(string); isLikelyRealAnthropicThinkingSignature(signature) {
					preface = append(preface, map[string]any{"type": "thinking", "thinking": thinking, "signature": signature})
				}
			}
		case "toolCall", "tool_call":
			id := firstString(part, "id", "call_id")
			name := types.NamespacedToolName(firstString(part, "namespace"), firstString(part, "name"))
			input := part["arguments"]
			if input == nil {
				input = map[string]any{}
			}
			toolUses = append(toolUses, map[string]any{"type": "tool_use", "id": id, "name": names.toWire(name), "input": input})
			toolIDs = append(toolIDs, id)
		}
	}
	// Anthropic treats text/thinking after tool_use as ending the tool turn, which makes
	// earlier tool_use ids look unpaired (#620 / common multi-step history shape).
	out := append(preface, toolUses...)
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
	var content any
	if json.Unmarshal(message.Content, &content) != nil {
		content = string(message.Content)
	}
	if text, ok := content.(string); ok {
		return fmt.Sprintf("[tool_result without adjacent tool_use: %s]\n%s", label, text)
	}
	encoded, _ := json.Marshal(content)
	return fmt.Sprintf("[tool_result without adjacent tool_use: %s]\n%s", label, encoded)
}

func anthropicTools(tools []types.Tool, names toolNameTransforms) []any {
	out := make([]any, 0, len(tools))
	for _, tool := range tools {
		name := names.toWire(types.NamespacedToolName(tool.Namespace, tool.Name))
		schema := normalizeAnthropicInputSchema(tool.Parameters)
		out = append(out, map[string]any{"name": name, "description": tool.Description, "input_schema": schema})
	}
	return out
}

func applyToolChoice(body map[string]any, choice anthropicToolChoice, tools []types.Tool, names toolNameTransforms) {
	if choice.Mode != "" {
		typesByName := map[string]string{"auto": "auto", "none": "none", "required": "any"}
		if len(choice.AllowedTools) > 0 {
			if choice.Mode == "required" {
				body["tool_choice"] = map[string]any{"type": "any"}
			} else {
				body["tool_choice"] = map[string]any{"type": "auto"}
			}
		} else if mapped := typesByName[choice.Mode]; mapped != "" {
			body["tool_choice"] = map[string]any{"type": mapped}
		}
		return
	}
	if choice.Name != "" {
		wireName := types.ResolveToolChoiceWireName(tools, choice.Name)
		if wireName != "" {
			body["tool_choice"] = map[string]any{"type": "tool", "name": names.toWire(wireName)}
		}
	}
}

func applyThinking(body map[string]any, effort string, explicitMax int) {
	if effort == "" || effort == "none" {
		return
	}
	budget := map[string]int{"minimal": 1024, "low": 4096, "medium": 8192, "high": 16384, "xhigh": 24576, "max": 32000}[effort]
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
		if body == nil {
			emit(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "No response body"})
			return
		}
		streamCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		names := a.toolNames()
		blocks := make(map[int]*pendingTool)
		blockTypes := make(map[int]string)
		var usage map[string]int
		stopReason := ""
		terminal := false
		for decoded := range decodeSSE(streamCtx, body) {
			if decoded.Err != nil {
				emit(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "read upstream SSE stream: " + decoded.Err.Error(), StatusCode: http.StatusBadGateway})
				return
			}
			frame := decoded.Event
			if frame.Comment != nil {
				emit(ctx, out, types.AdapterEvent{Type: types.EventHeartbeat})
				continue
			}
			var event map[string]any
			if json.Unmarshal([]byte(frame.Data), &event) != nil {
				continue
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
					pending := &pendingTool{id: firstString(block, "id"), name: names.fromWire(firstString(block, "name"))}
					if input := block["input"]; input != nil {
						if encoded, err := json.Marshal(input); err == nil && string(encoded) != "{}" {
							pending.arguments.Write(encoded)
						}
					}
					blocks[index] = pending
				} else if blockType == "redacted_thinking" {
					emit(ctx, out, types.AdapterEvent{Type: types.EventRedactedThinking, Data: firstString(block, "data")})
				}
			case "content_block_delta":
				index := intValue(event["index"])
				delta, _ := event["delta"].(map[string]any)
				switch delta["type"] {
				case "text_delta":
					emit(ctx, out, types.AdapterEvent{Type: types.EventTextDelta, Text: firstString(delta, "text")})
				case "thinking_delta", "reasoning_delta":
					emit(ctx, out, types.AdapterEvent{Type: types.EventReasoning, Reasoning: firstString(delta, "thinking", "reasoning")})
				case "signature_delta":
					if blockTypes[index] == "thinking" || blockTypes[index] == "reasoning" {
						emit(ctx, out, types.AdapterEvent{Type: types.EventThinkingSignature, Signature: firstString(delta, "signature")})
					}
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
			if stopReason == "" {
				emit(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "upstream stream ended before message_stop — possible truncation"})
				return
			}
			mappedStopReason := ""
			switch stopReason {
			case "max_tokens":
				mappedStopReason = "max_tokens"
			case "refusal", "content_filter":
				mappedStopReason = "content_filter"
			}
			emit(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: anthropicUsage(usage), StopReason: mappedStopReason})
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
	names := a.toolNames()
	for _, raw := range sliceValue(response["content"]) {
		block, _ := raw.(map[string]any)
		switch block["type"] {
		case "text":
			if text := firstString(block, "text"); text != "" {
				events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
		case "thinking", "reasoning":
			events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: firstString(block, "thinking", "reasoning")})
			if signature := firstString(block, "signature"); signature != "" {
				events = append(events, types.AdapterEvent{Type: types.EventThinkingSignature, Signature: signature})
			}
		case "redacted_thinking":
			events = append(events, types.AdapterEvent{Type: types.EventRedactedThinking, Data: firstString(block, "data")})
		case "tool_use":
			arguments, _ := json.Marshal(block["input"])
			if !json.Valid(arguments) {
				arguments = []byte("{}")
			}
			events = append(events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: firstString(block, "id"), Name: names.fromWire(firstString(block, "name")), Arguments: arguments}})
		}
	}
	events = append(events, types.AdapterEvent{Type: types.EventDone, Usage: anthropicUsage(mergeUsage(nil, response["usage"])), StopReason: firstString(response, "stop_reason")})
	return events, nil
}

type decodedSSE struct {
	Event protocol.SSEEvent
	Err   error
}

func decodeSSE(ctx context.Context, body io.ReadCloser) <-chan decodedSSE {
	out := make(chan decodedSSE)
	if body == nil {
		close(out)
		return out
	}
	go func() {
		defer close(out)
		defer body.Close()
		decoded := make(chan protocol.SSEEvent)
		decoder := protocol.NewSSEDecoderWithComments(decoded)
		copyDone := make(chan error, 1)
		go func() {
			_, copyErr := io.Copy(decoder, body)
			closeErr := decoder.Close()
			close(decoded)
			if copyErr == nil {
				copyErr = closeErr
			}
			copyDone <- copyErr
		}()
		for {
			select {
			case event, ok := <-decoded:
				if !ok {
					if err := <-copyDone; err != nil && ctx.Err() == nil {
						select {
						case out <- decodedSSE{Err: err}:
						case <-ctx.Done():
						}
					}
					return
				}
				select {
				case out <- decodedSSE{Event: event}:
				case <-ctx.Done():
					_ = body.Close()
					for range decoded {
					}
					return
				}
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
