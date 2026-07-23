package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

var ForwardHeaders = []string{
	"authorization", "chatgpt-account-id", "openai-beta", "originator",
	"session_id", "session-id", "thread-id", "x-client-request-id",
	"x-codex-beta-features", "x-codex-installation-id", "x-codex-parent-thread-id",
	"x-codex-turn-metadata", "x-codex-turn-state", "x-codex-window-id",
	"x-oai-attestation", "x-openai-subagent", "x-responsesapi-include-timing-metrics",
}

type ResponsesAdapter struct {
	BaseURL         string
	Client          *http.Client
	APIKey          string
	Headers         map[string]string
	IncomingHeaders http.Header
	ForwardAuth     bool
}

var _ types.Adapter = (*ResponsesAdapter)(nil)

func (a *ResponsesAdapter) HTTPClient() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return NewHTTPClient(0)
}

func (a *ResponsesAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if req == nil {
		return nil, fmt.Errorf("build responses request: nil normalized request")
	}
	endpoint, err := responsesEndpoint(a.BaseURL, a.ForwardAuth)
	if err != nil {
		return nil, err
	}
	body, err := responsesRequestBody(req)
	if err != nil {
		return nil, fmt.Errorf("build responses request body: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build responses request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if req.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	SetBearerAuth(httpReq.Header, a.APIKey)
	InjectHeaders(httpReq.Header, a.Headers)
	if a.ForwardAuth {
		for _, key := range ForwardHeaders {
			if value := a.IncomingHeaders.Get(key); value != "" {
				httpReq.Header.Set(key, value)
			}
		}
	}
	return httpReq, nil
}

func responsesEndpoint(baseURL string, forward bool) (string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid OpenAI base URL %q", baseURL)
	}
	if forward {
		return baseURL + "/responses", nil
	}
	if strings.HasSuffix(baseURL, "/v1") {
		return baseURL + "/responses", nil
	}
	return baseURL + "/v1/responses", nil
}

func responsesRequestBody(req *types.NormalizedRequest) ([]byte, error) {
	if len(bytes.TrimSpace(req.RawBody)) > 0 {
		var body map[string]any
		if err := json.Unmarshal(req.RawBody, &body); err != nil {
			return nil, err
		}
		body["model"] = req.ModelID
		body["stream"] = req.Stream
		return json.Marshal(sanitizeResponsesBody(body))
	}
	body := map[string]any{
		"model":  req.ModelID,
		"input":  req.Context.Messages,
		"stream": req.Stream,
	}
	if len(req.Context.SystemPrompt) > 0 {
		body["instructions"] = strings.Join(req.Context.SystemPrompt, "\n\n")
	}
	if req.PreviousResponseID != "" {
		body["previous_response_id"] = req.PreviousResponseID
	}
	if len(req.Context.Tools) > 0 {
		body["tools"] = responsesTools(req.Context.Tools)
	}
	applyResponsesOptions(body, req.Options)
	return json.Marshal(body)
}

func applyResponsesOptions(body map[string]any, options types.RequestOptions) {
	if options.MaxOutputTokens > 0 {
		body["max_output_tokens"] = options.MaxOutputTokens
	}
	if options.Temperature != nil {
		body["temperature"] = *options.Temperature
	}
	if options.TopP != nil {
		body["top_p"] = *options.TopP
	}
	if len(options.ToolChoice) > 0 && json.Valid(options.ToolChoice) {
		var choice any
		if json.Unmarshal(options.ToolChoice, &choice) == nil {
			body["tool_choice"] = choice
		}
	}
	if options.ParallelToolCalls != nil {
		body["parallel_tool_calls"] = *options.ParallelToolCalls
	}
	if options.Reasoning != "" {
		body["reasoning"] = map[string]any{"effort": options.Reasoning}
	}
	if options.ServiceTier != "" {
		body["service_tier"] = options.ServiceTier
	}
}

func sanitizeResponsesBody(body map[string]any) map[string]any {
	input, ok := body["input"].([]any)
	if !ok {
		return body
	}
	for _, rawItem := range input {
		item, ok := rawItem.(map[string]any)
		if !ok || item["type"] != "reasoning" {
			continue
		}
		if content, ok := item["content"].([]any); ok && len(content) > 0 {
			item["content"] = []any{}
		}
		if encrypted, ok := item["encrypted_content"].(string); ok && strings.HasPrefix(encrypted, "ocxr1:") {
			delete(item, "encrypted_content")
			item["content"] = []any{}
		}
	}
	return body
}

func responsesTools(tools []types.Tool) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		out = append(out, map[string]any{
			"type": "function", "name": NamespacedToolName(tool),
			"description": tool.Description, "parameters": tool.Parameters, "strict": tool.Strict,
		})
	}
	return out
}

func (a *ResponsesAdapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		calls := make(map[string]*types.ToolCall)
		for frame := range decodeSSE(ctx, body) {
			if frame.Data == "[DONE]" {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventDone})
				return
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(frame.Data), &event); err != nil {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "malformed upstream SSE data frame"})
				return
			}
			terminal := parseResponsesStreamEvent(event, calls, func(adapterEvent types.AdapterEvent) bool {
				return sendAdapterEvent(ctx, out, adapterEvent)
			})
			if terminal {
				return
			}
		}
		if ctx.Err() == nil {
			sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "upstream stream ended without a terminal signal"})
		}
	}()
	return out
}

func parseResponsesStreamEvent(event map[string]any, calls map[string]*types.ToolCall, emit func(types.AdapterEvent) bool) bool {
	eventType, _ := event["type"].(string)
	switch eventType {
	case "response.output_text.delta":
		emit(types.AdapterEvent{Type: types.EventTextDelta, Text: stringValue(event["delta"])})
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		emit(types.AdapterEvent{Type: types.EventReasoning, Reasoning: stringValue(event["delta"])})
	case "response.output_item.added":
		rememberResponsesToolCall(event["item"], calls)
	case "response.function_call_arguments.delta":
		id := firstString(event, "item_id", "call_id")
		call := ensureResponseCall(calls, id)
		call.Arguments = append(call.Arguments, []byte(stringValue(event["delta"]))...)
	case "response.output_item.done":
		if call := completedResponsesToolCall(event["item"], calls); call != nil {
			emit(types.AdapterEvent{Type: types.EventToolCall, ToolCall: call})
		}
	case "response.completed":
		response, _ := event["response"].(map[string]any)
		emit(types.AdapterEvent{Type: types.EventDone, Usage: responsesUsage(response["usage"]), StopReason: stringValue(response["status"])})
		return true
	case "response.failed", "error":
		emit(types.AdapterEvent{Type: types.EventError, Error: responsesErrorMessage(event)})
		return true
	}
	return false
}

func (a *ResponsesAdapter) ParseUnary(_ context.Context, body []byte) ([]types.AdapterEvent, error) {
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("parse Responses response: %w", err)
	}
	if response["error"] != nil {
		return []types.AdapterEvent{{Type: types.EventError, Error: responsesErrorMessage(response)}}, nil
	}
	events := make([]types.AdapterEvent, 0)
	for _, rawItem := range sliceValue(response["output"]) {
		item, ok := rawItem.(map[string]any)
		if !ok {
			continue
		}
		switch item["type"] {
		case "message":
			for _, rawContent := range sliceValue(item["content"]) {
				content, _ := rawContent.(map[string]any)
				if content["type"] == "output_text" {
					events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: stringValue(content["text"])})
				}
			}
		case "reasoning":
			for _, rawSummary := range sliceValue(item["summary"]) {
				summary, _ := rawSummary.(map[string]any)
				if text := stringValue(summary["text"]); text != "" {
					events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: text})
				}
			}
		case "function_call":
			if call := toolCallFromResponseItem(item); call != nil {
				events = append(events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: call})
			}
		}
	}
	events = append(events, types.AdapterEvent{Type: types.EventDone, Usage: responsesUsage(response["usage"]), StopReason: stringValue(response["status"])})
	return events, nil
}

func rememberResponsesToolCall(value any, calls map[string]*types.ToolCall) {
	item, ok := value.(map[string]any)
	if !ok {
		return
	}
	if call := toolCallFromResponseItem(item); call != nil {
		calls[stringValue(item["id"])] = call
	}
}

func ensureResponseCall(calls map[string]*types.ToolCall, id string) *types.ToolCall {
	if call := calls[id]; call != nil {
		return call
	}
	call := &types.ToolCall{ID: id, Arguments: json.RawMessage{}}
	calls[id] = call
	return call
}

func toolCallFromResponseItem(value any) *types.ToolCall {
	item, ok := value.(map[string]any)
	if !ok || item["type"] != "function_call" {
		return nil
	}
	id := firstString(item, "call_id", "id")
	arguments := []byte(stringValue(item["arguments"]))
	if !json.Valid(arguments) {
		arguments = []byte("{}")
	}
	return &types.ToolCall{ID: id, Name: stringValue(item["name"]), Arguments: arguments}
}

func completedResponsesToolCall(value any, calls map[string]*types.ToolCall) *types.ToolCall {
	item, ok := value.(map[string]any)
	if !ok || item["type"] != "function_call" {
		return nil
	}
	itemID := stringValue(item["id"])
	completed := toolCallFromResponseItem(item)
	if pending := calls[itemID]; pending != nil {
		if completed.ID == "" {
			completed.ID = pending.ID
		}
		if completed.Name == "" {
			completed.Name = pending.Name
		}
		if len(completed.Arguments) == 0 || string(completed.Arguments) == "{}" {
			if json.Valid(pending.Arguments) {
				completed.Arguments = pending.Arguments
			}
		}
	}
	delete(calls, itemID)
	return completed
}

func responsesUsage(value any) *types.Usage {
	usage, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input := intValue(usage["input_tokens"])
	output := intValue(usage["output_tokens"])
	result := &types.Usage{InputTokens: input, OutputTokens: output, TotalTokens: intValue(usage["total_tokens"])}
	if details, ok := usage["input_tokens_details"].(map[string]any); ok {
		result.CachedInputTokens = intValue(details["cached_tokens"])
	}
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		result.ReasoningOutputTokens = intValue(details["reasoning_tokens"])
	}
	return result
}

func responsesErrorMessage(event map[string]any) string {
	if message := stringValue(event["message"]); message != "" {
		return SanitizeUpstreamErrorText(message)
	}
	if errObj, ok := event["error"].(map[string]any); ok {
		if message := stringValue(errObj["message"]); message != "" {
			return SanitizeUpstreamErrorText(message)
		}
	}
	if response, ok := event["response"].(map[string]any); ok {
		if errorObj, ok := response["error"].(map[string]any); ok {
			return SanitizeUpstreamErrorText(stringValue(errorObj["message"]))
		}
	}
	return "upstream error"
}

func firstString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringValue(object[key]); value != "" {
			return value
		}
	}
	return ""
}

func stringValue(value any) string { text, _ := value.(string); return text }
func sliceValue(value any) []any   { result, _ := value.([]any); return result }
func intValue(value any) int       { number, _ := value.(float64); return int(number) }
