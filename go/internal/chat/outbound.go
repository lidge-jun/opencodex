package chat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// Outbound converts normalized adapter events to Chat Completions responses.
type Outbound struct{ Model string }

var _ types.ChatOutbound = Outbound{}

func (o Outbound) ToChatCompletions(_ context.Context, events []types.AdapterEvent) (*types.ChatResponse, error) {
	content, reasoning, calls, usage, finish, err := foldChatEvents(events)
	if err != nil {
		return nil, err
	}
	return &types.ChatResponse{
		ID: completionID(), Object: "chat.completion", Created: time.Now().Unix(), Model: o.Model,
		Choices: []types.ChatChoice{{Index: 0, Message: types.ChatMessage{Role: "assistant", Content: content, Reasoning: reasoning, ToolCalls: calls}, FinishReason: finish}},
		Usage:   chatUsageStruct(usage),
	}, nil
}

// BuildChatCompletion returns the exact OpenAI-compatible non-streaming wire shape.
func BuildChatCompletion(events []types.AdapterEvent, model string) (map[string]any, error) {
	content, reasoning, calls, usage, finish, err := foldChatEvents(events)
	if err != nil {
		return nil, err
	}
	message := map[string]any{"role": "assistant", "content": nil}
	if content != "" {
		message["content"] = content
	}
	if reasoning != "" {
		message["reasoning_content"] = reasoning
	}
	if len(calls) > 0 {
		wireCalls := make([]map[string]any, 0, len(calls))
		for _, call := range calls {
			arguments := string(call.Arguments)
			if arguments == "" {
				arguments = "{}"
			}
			wireCalls = append(wireCalls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": arguments}})
		}
		message["tool_calls"] = wireCalls
	}
	return map[string]any{
		"id": completionID(), "object": "chat.completion", "created": time.Now().Unix(), "model": model,
		"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish, "logprobs": nil}},
		"usage":   chatUsage(usage),
	}, nil
}

// WriteChatStream translates an AdapterEvent stream to Chat Completions SSE.
func WriteChatStream(ctx context.Context, w http.ResponseWriter, model string, events <-chan types.AdapterEvent) error {
	id, created := completionID(), time.Now().Unix()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	started, sawTool, terminal := false, false, false
	var usage *types.Usage
	toolIndexByID := make(map[string]int)
	nextToolIndex := 0
	ensureRole := func() error {
		if started {
			return nil
		}
		started = true
		return writeChatData(w, chatChunk(id, model, created, map[string]any{"role": "assistant", "content": ""}, nil, nil), flusher)
	}
	for !terminal {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-events:
			if !ok {
				if terminal {
					return nil
				}
				return writeChatStreamError(w, "upstream stream ended before a terminal event", flusher)
			}
			switch event.Type {
			case types.EventTextDelta:
				if event.Text == "" {
					continue
				}
				if err := ensureRole(); err != nil {
					return err
				}
				if err := writeChatData(w, chatChunk(id, model, created, map[string]any{"content": event.Text}, nil, nil), flusher); err != nil {
					return err
				}
			case types.EventReasoning:
				text := event.Reasoning
				if text == "" {
					text = event.Text
				}
				if text == "" {
					continue
				}
				if err := ensureRole(); err != nil {
					return err
				}
				if err := writeChatData(w, chatChunk(id, model, created, map[string]any{"reasoning_content": text}, nil, nil), flusher); err != nil {
					return err
				}
			case types.EventToolCall:
				if event.ToolCall == nil {
					continue
				}
				if err := ensureRole(); err != nil {
					return err
				}
				sawTool = true
				call := event.ToolCall
				toolIndex, known := toolIndexByID[call.ID]
				if !known {
					toolIndex = nextToolIndex
					nextToolIndex++
					toolIndexByID[call.ID] = toolIndex
				}
				arguments := string(call.Arguments)
				if arguments == "" {
					arguments = "{}"
				}
				delta := map[string]any{"tool_calls": []any{map[string]any{"index": toolIndex, "id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": arguments}}}}
				if err := writeChatData(w, chatChunk(id, model, created, delta, nil, nil), flusher); err != nil {
					return err
				}
			case types.EventUsage:
				usage = event.Usage
			case types.EventHeartbeat:
				continue
			case types.EventError:
				terminal = true
				message := event.Error
				if message == "" {
					message = "upstream request failed"
				}
				return writeChatStreamError(w, message, flusher)
			case types.EventDone:
				terminal = true
				if event.Usage != nil {
					usage = event.Usage
				}
				if err := ensureRole(); err != nil {
					return err
				}
				finish := chatFinishReason(event.StopReason, sawTool)
				if err := writeChatData(w, chatChunk(id, model, created, map[string]any{}, &finish, usage), flusher); err != nil {
					return err
				}
				if _, err := io.WriteString(w, "data: [DONE]\n\n"); err != nil {
					return err
				}
				if flusher != nil {
					flusher.Flush()
				}
			case types.EventIncomplete:
				terminal = true
				if event.Usage != nil {
					usage = event.Usage
				}
				if event.Reason != "max_output_tokens" && event.Reason != "content_filter" {
					if err := writeChatStreamError(w, fmt.Sprintf("upstream stream ended early (%s)", event.Reason), flusher); err != nil {
						return err
					}
					return nil
				}
				if err := ensureRole(); err != nil {
					return err
				}
				finish := chatFinishReason(event.Reason, false)
				if err := writeChatData(w, chatChunk(id, model, created, map[string]any{}, &finish, usage), flusher); err != nil {
					return err
				}
				if _, err := io.WriteString(w, "data: [DONE]\n\n"); err != nil {
					return err
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
		}
	}
	return nil
}

func foldChatEvents(events []types.AdapterEvent) (string, string, []types.ToolCall, *types.Usage, string, error) {
	var content, reasoning strings.Builder
	var calls []types.ToolCall
	var usage *types.Usage
	finish, done := "stop", false
	for _, event := range events {
		switch event.Type {
		case types.EventTextDelta:
			content.WriteString(event.Text)
		case types.EventReasoning:
			if event.Reasoning != "" {
				reasoning.WriteString(event.Reasoning)
			} else {
				reasoning.WriteString(event.Text)
			}
		case types.EventToolCall:
			if event.ToolCall != nil {
				calls = append(calls, *event.ToolCall)
			}
		case types.EventUsage:
			usage = event.Usage
		case types.EventHeartbeat:
			continue
		case types.EventError:
			message := event.Error
			if message == "" {
				message = "upstream request failed"
			}
			return "", "", nil, usage, "", fmt.Errorf("%s", message)
		case types.EventDone:
			done = true
			if event.Usage != nil {
				usage = event.Usage
			}
			finish = chatFinishReason(event.StopReason, len(calls) > 0)
		case types.EventIncomplete:
			done = true
			if event.Usage != nil {
				usage = event.Usage
			}
			finish = chatFinishReason(event.Reason, false)
		}
	}
	if !done {
		return "", "", nil, usage, "", fmt.Errorf("adapter stream ended without a terminal event")
	}
	return content.String(), reasoning.String(), calls, usage, finish, nil
}

func chatFinishReason(reason string, sawTool bool) string {
	if sawTool {
		return "tool_calls"
	}
	switch reason {
	case "max_output_tokens", "max_tokens", "length":
		return "length"
	case "content_filter", "refusal":
		return "content_filter"
	default:
		return "stop"
	}
}

func chatUsage(value *types.Usage) map[string]any {
	if value == nil {
		return map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
	}
	total := value.TotalTokens
	if total == 0 {
		total = value.InputTokens + value.OutputTokens
	}
	out := map[string]any{"prompt_tokens": value.InputTokens, "completion_tokens": value.OutputTokens, "total_tokens": total}
	if value.CachedInputTokens > 0 || value.CacheReadInputTokens > 0 {
		cached := value.CachedInputTokens
		if cached == 0 {
			cached = value.CacheReadInputTokens
		}
		out["prompt_tokens_details"] = map[string]any{"cached_tokens": cached}
	}
	if value.ReasoningOutputTokens > 0 {
		out["completion_tokens_details"] = map[string]any{"reasoning_tokens": value.ReasoningOutputTokens}
	}
	return out
}

func chatUsageStruct(value *types.Usage) *types.ChatUsage {
	if value == nil {
		return &types.ChatUsage{}
	}
	total := value.TotalTokens
	if total == 0 {
		total = value.InputTokens + value.OutputTokens
	}
	return &types.ChatUsage{PromptTokens: value.InputTokens, CompletionTokens: value.OutputTokens, TotalTokens: total}
}

func chatChunk(id, model string, created int64, delta map[string]any, finish *string, usage *types.Usage) map[string]any {
	choice := map[string]any{"index": 0, "delta": delta, "finish_reason": nil}
	if finish != nil {
		choice["finish_reason"] = *finish
	}
	out := map[string]any{"id": id, "object": "chat.completion.chunk", "created": created, "model": model, "choices": []any{choice}}
	if usage != nil {
		out["usage"] = chatUsage(usage)
	}
	return out
}

func writeChatData(w io.Writer, payload any, flusher http.Flusher) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return err
	}
	if flusher != nil {
		flusher.Flush()
	}
	return nil
}

func writeChatStreamError(w io.Writer, message string, flusher http.Flusher) error {
	status := streamErrorStatus(message)
	payload := map[string]any{"error": map[string]any{"message": message, "type": chatErrorType(status), "param": nil, "code": chatErrorCode(status)}}
	return writeChatData(w, payload, flusher)
}

func streamErrorStatus(message string) int {
	lower := strings.ToLower(message)
	switch {
	case strings.Contains(lower, "429"), strings.Contains(lower, "rate"):
		return 429
	case strings.Contains(lower, "401"), strings.Contains(lower, "unauthor"), strings.Contains(lower, "api key"):
		return 401
	case strings.Contains(lower, "404"), strings.Contains(lower, "not found"):
		return 404
	case strings.Contains(lower, "400"), strings.Contains(lower, "invalid"):
		return 400
	default:
		return 502
	}
}

func chatErrorType(status int) string {
	if status == 401 {
		return "authentication_error"
	}
	if status == 429 {
		return "rate_limit_error"
	}
	if status >= 500 {
		return "server_error"
	}
	return "invalid_request_error"
}
func chatErrorCode(status int) any {
	if status == 401 {
		return "invalid_api_key"
	}
	if status == 404 {
		return "model_not_found"
	}
	if status == 429 {
		return "rate_limit_exceeded"
	}
	return nil
}
func completionID() string {
	data := make([]byte, 12)
	_, _ = rand.Read(data)
	return "chatcmpl-" + hex.EncodeToString(data)
}
