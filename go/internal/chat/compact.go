package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	CompactionPrefix = "ocx1:"
	CompactPrompt    = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`
	SummaryPrefix                  = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"
	OpaqueCompactionNote           = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]"
	compactRetainedCharacterBudget = 20_000 * 4
	compactResponseLimit           = int64(32 << 20)
)

type CompactHandler struct{ config HandlerConfig }

var _ types.RouteHandler = (*CompactHandler)(nil)

func NewCompactHandler(config HandlerConfig) *CompactHandler {
	return &CompactHandler{config: withHandlerDefaults(config)}
}

func (h *CompactHandler) Handle(w http.ResponseWriter, r *http.Request) {
	raw, err := readRequestBody(w, r, h.config.BodyLimit)
	if err != nil {
		writeResponsesError(w, 400, "invalid_request_error", err.Error())
		return
	}
	var body struct {
		Model    string            `json:"model"`
		Input    []json.RawMessage `json:"input"`
		ThreadID string            `json:"thread_id"`
	}
	if json.Unmarshal(raw, &body) != nil {
		writeResponsesError(w, 400, "invalid_request_error", "Invalid compaction request body")
		return
	}
	if strings.TrimSpace(body.Model) == "" {
		writeResponsesError(w, 400, "invalid_request_error", "compaction request requires a model")
		return
	}
	if h.config.Compactor != nil {
		result, err := h.config.Compactor.Compact(r.Context(), &types.CompactionRequest{Model: body.Model, Input: body.Input, ThreadID: body.ThreadID})
		if err != nil {
			writeResponsesError(w, 502, "upstream_error", err.Error())
			return
		}
		if result == nil {
			writeResponsesError(w, 502, "server_error", "compactor returned no result")
			return
		}
		if len(result.Output) > 0 {
			writeJSON(w, 200, map[string]any{"output": result.Output})
			return
		}
		writeJSON(w, 200, map[string]any{"output": BuildCompactReplay(ExtractCompactUserMessages(body.Input), result.Summary)})
		return
	}
	normalized := compactNormalizedRequest(body.Model, body.Input)
	prepared, err := h.config.prepare(r.Context(), r.Header, normalized)
	if err != nil {
		writeResponsesErrorFor(w, err)
		return
	}
	if h.shouldNativeCompact(prepared.resolved) {
		h.nativeCompact(w, r, raw, prepared)
		return
	}
	response, err := h.config.do(r.Context(), prepared)
	if err != nil {
		writeResponsesErrorFor(w, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeResponsesError(w, response.StatusCode, "upstream_error", readProviderError(response.Body, h.config.ResponseLimit))
		return
	}
	payload, err := readBounded(response.Body, min64(h.config.ResponseLimit, compactResponseLimit))
	if err != nil {
		writeResponsesError(w, 502, "compact_response_too_large", err.Error())
		return
	}
	events, err := prepared.adapter.ParseUnary(r.Context(), payload)
	if err != nil {
		writeResponsesError(w, 502, "server_error", err.Error())
		return
	}
	summary, err := compactionSummary(events)
	if err != nil {
		writeResponsesError(w, 502, "server_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"output": BuildCompactReplay(ExtractCompactUserMessages(body.Input), summary)})
}

func EncodeCompactionSummary(summary string) string {
	return CompactionPrefix + base64.StdEncoding.EncodeToString([]byte(summary))
}

func DecodeCompactionSummary(encrypted string) (string, bool) {
	if !strings.HasPrefix(encrypted, CompactionPrefix) {
		return "", false
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encrypted, CompactionPrefix))
	if err != nil {
		return "", false
	}
	return string(data), true
}

func CompactionItemToText(encrypted string) string {
	if decoded, ok := DecodeCompactionSummary(encrypted); ok && decoded != "" {
		return SummaryPrefix + "\n\n" + decoded
	}
	return OpaqueCompactionNote
}

func ExtractCompactUserMessages(input []json.RawMessage) []string {
	out := make([]string, 0)
	for _, raw := range input {
		var item map[string]any
		if json.Unmarshal(raw, &item) != nil {
			continue
		}
		kind, _ := item["type"].(string)
		role, _ := item["role"].(string)
		if kind != "" && kind != "message" || role != "user" {
			continue
		}
		text := responsesContentText(item["content"])
		if strings.TrimSpace(text) != "" {
			out = append(out, text)
		}
	}
	return out
}

func BuildCompactReplay(userMessages []string, summary string) []json.RawMessage {
	selected := make([]string, 0, len(userMessages))
	remaining := compactRetainedCharacterBudget
	for index := len(userMessages) - 1; index >= 0 && remaining > 0; index-- {
		runes := []rune(userMessages[index])
		if len(runes) <= remaining {
			selected = append(selected, string(runes))
			remaining -= len(runes)
		} else {
			selected = append(selected, string(runes[len(runes)-remaining:]))
			break
		}
	}
	for left, right := 0, len(selected)-1; left < right; left, right = left+1, right-1 {
		selected[left], selected[right] = selected[right], selected[left]
	}
	if strings.TrimSpace(summary) != "" {
		selected = append(selected, SummaryPrefix+"\n"+summary)
	} else {
		selected = append(selected, "(no summary available)")
	}
	out := make([]json.RawMessage, 0, len(selected))
	for _, text := range selected {
		out = append(out, mustJSON(map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}}}))
	}
	return out
}

func compactNormalizedRequest(model string, input []json.RawMessage) *types.NormalizedRequest {
	req := &types.NormalizedRequest{ModelID: model, Stream: false}
	for _, raw := range input {
		appendResponsesItem(&req.Context.Messages, raw)
	}
	req.Context.Messages = append(req.Context.Messages, types.Message{Role: "user", Content: mustJSON([]any{map[string]any{"type": "input_text", "text": CompactPrompt}})})
	return req
}

func appendResponsesItem(messages *[]types.Message, raw json.RawMessage) {
	var item map[string]any
	if json.Unmarshal(raw, &item) != nil {
		return
	}
	kind, _ := item["type"].(string)
	switch kind {
	case "", "message":
		role, _ := item["role"].(string)
		if role != "user" && role != "assistant" {
			return
		}
		content := normalizeResponsesMessageContent(role, item["content"])
		if len(content) > 0 {
			*messages = append(*messages, types.Message{Role: role, Content: mustJSON(content)})
		}
	case "function_call":
		id, _ := item["call_id"].(string)
		name, _ := item["name"].(string)
		arguments := decodeArguments(item["arguments"])
		*messages = append(*messages, types.Message{Role: "assistant", Content: mustJSON([]any{map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": arguments}})})
	case "function_call_output":
		id, _ := item["call_id"].(string)
		*messages = append(*messages, types.Message{Role: "toolResult", ToolCallID: id, Content: mustJSON(item["output"])})
	case "compaction":
		encrypted, _ := item["encrypted_content"].(string)
		*messages = append(*messages, types.Message{Role: "user", Content: mustJSON([]any{map[string]any{"type": "input_text", "text": CompactionItemToText(encrypted)}})})
	}
}

func normalizeResponsesMessageContent(role string, content any) []any {
	if text, ok := content.(string); ok {
		kind := "input_text"
		if role == "assistant" {
			kind = "output_text"
		}
		return []any{map[string]any{"type": kind, "text": text}}
	}
	parts, _ := content.([]any)
	out := make([]any, 0, len(parts))
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := part["type"].(string)
		if role == "assistant" && (kind == "text" || kind == "output_text") {
			out = append(out, map[string]any{"type": "output_text", "text": part["text"]})
		} else if role == "user" && (kind == "text" || kind == "input_text" || kind == "input_image") {
			out = append(out, part)
		}
	}
	return out
}

func responsesContentText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	parts, _ := content.([]any)
	var out strings.Builder
	for _, value := range parts {
		part, ok := value.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := part["type"].(string)
		if kind == "text" || kind == "input_text" {
			if text, ok := part["text"].(string); ok {
				out.WriteString(text)
			}
		}
	}
	return out.String()
}

func compactionSummary(events []types.AdapterEvent) (string, error) {
	var text, reasoning strings.Builder
	done := false
	for _, event := range events {
		switch event.Type {
		case types.EventTextDelta:
			text.WriteString(event.Text)
		case types.EventReasoning:
			if event.Reasoning != "" {
				reasoning.WriteString(event.Reasoning)
			} else {
				reasoning.WriteString(event.Text)
			}
		case types.EventError:
			return "", fmt.Errorf("%s", firstNonEmpty(event.Error, "compaction turn failed"))
		case types.EventDone, types.EventIncomplete:
			done = true
		case types.EventHeartbeat:
			continue
		}
	}
	if !done {
		return "", fmt.Errorf("compaction turn ended without a terminal event")
	}
	if text.Len() > 0 {
		return text.String(), nil
	}
	return reasoning.String(), nil
}

func (h *CompactHandler) shouldNativeCompact(model *types.ResolvedModel) bool {
	if h.config.NativeCompact != nil {
		return h.config.NativeCompact(model)
	}
	provider := strings.ToLower(model.Provider)
	return provider == "openai" || provider == "chatgpt"
}

func (h *CompactHandler) nativeCompact(w http.ResponseWriter, r *http.Request, raw []byte, prepared *preparedRequest) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		writeResponsesError(w, 400, "invalid_request_error", "Invalid compaction request body")
		return
	}
	body["model"] = prepared.resolved.Model
	delete(body, "reasoning")
	payload, _ := json.Marshal(body)
	endpoint, err := nativeCompactURL(prepared.transport.BaseURL)
	if err != nil {
		writeResponsesError(w, 502, "upstream_error", err.Error())
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint, strings.NewReader(string(payload)))
	if err != nil {
		writeResponsesError(w, 500, "server_error", err.Error())
		return
	}
	request.Header.Set("Content-Type", "application/json")
	for name, value := range prepared.transport.Headers {
		request.Header.Set(name, value)
	}
	if prepared.auth != nil {
		for name, value := range prepared.auth.Headers {
			request.Header.Set(name, value)
		}
		if prepared.auth.AccessToken != "" {
			request.Header.Set("Authorization", "Bearer "+prepared.auth.AccessToken)
		}
		if prepared.auth.APIKey != "" {
			request.Header.Set("Authorization", "Bearer "+prepared.auth.APIKey)
		}
	}
	response, err := h.config.Client.Do(request)
	if err != nil {
		if r.Context().Err() != nil {
			writeResponsesError(w, 499, "client_cancelled", "Client cancelled compact request")
		} else {
			writeResponsesError(w, 502, "upstream_error", "Failed to connect to compact upstream")
		}
		return
	}
	defer response.Body.Close()
	data, err := readBounded(response.Body, compactResponseLimit)
	if err != nil {
		writeResponsesError(w, 502, "compact_response_too_large", "Compact response exceeded 32 MiB")
		return
	}
	w.Header().Set("Content-Type", firstNonEmpty(response.Header.Get("Content-Type"), "application/json"))
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(data)
}

func nativeCompactURL(base string) (string, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid OpenAI base URL %q", base)
	}
	if strings.HasSuffix(base, "/responses/compact") {
		return base, nil
	}
	return base + "/responses/compact", nil
}
func writeResponsesError(w http.ResponseWriter, status int, kind, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "type": kind, "code": kind}})
}
func writeResponsesErrorFor(w http.ResponseWriter, err error) {
	if typed, ok := err.(statusError); ok {
		kind := "invalid_request_error"
		if typed.status == 401 {
			kind = "authentication_error"
		} else if typed.status >= 500 {
			kind = "upstream_error"
		}
		writeResponsesError(w, typed.status, kind, typed.message)
		return
	}
	writeResponsesError(w, 500, "server_error", err.Error())
}

// CompactWith runs a configured compactor and returns replay items without HTTP.
func CompactWith(ctx context.Context, compactor types.CompactionHandler, request *types.CompactionRequest) ([]json.RawMessage, error) {
	result, err := compactor.Compact(ctx, request)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, fmt.Errorf("compactor returned no result")
	}
	if len(result.Output) > 0 {
		return result.Output, nil
	}
	return BuildCompactReplay(ExtractCompactUserMessages(request.Input), result.Summary), nil
}
