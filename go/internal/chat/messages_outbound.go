package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type incompleteError struct {
	status  int
	message string
}

func (e incompleteError) Error() string { return e.message }

func buildAnthropicMessage(events []types.AdapterEvent, model string) (map[string]any, error) {
	content := make([]any, 0)
	var usage *types.Usage
	stop, done := "end_turn", false
	for _, event := range events {
		switch event.Type {
		case types.EventTextDelta:
			if event.Text != "" {
				content = appendTextBlock(content, "text", "text", event.Text)
			}
		case types.EventReasoning:
			text := event.Reasoning
			if text == "" {
				text = event.Text
			}
			if text != "" {
				content = appendTextBlock(content, "thinking", "thinking", text)
			}
		case types.EventToolCall:
			if event.ToolCall != nil {
				input := any(map[string]any{})
				if json.Unmarshal(event.ToolCall.Arguments, &input) != nil {
					input = map[string]any{}
				}
				content = append(content, map[string]any{"type": "tool_use", "id": event.ToolCall.ID, "name": event.ToolCall.Name, "input": input})
				stop = "tool_use"
			}
		case types.EventUsage:
			usage = event.Usage
		case types.EventHeartbeat:
			continue
		case types.EventError:
			return nil, statusError{status: http.StatusBadGateway, message: firstNonEmpty(event.Error, "upstream request failed")}
		case types.EventDone:
			done = true
			if event.Usage != nil {
				usage = event.Usage
			}
			if stop != "tool_use" {
				stop = anthropicStopReason(event.StopReason)
			}
		case types.EventIncomplete:
			if event.Usage != nil {
				usage = event.Usage
			}
			switch event.Reason {
			case "max_output_tokens":
				stop, done = "max_tokens", true
			case "content_filter":
				stop, done = "refusal", true
			default:
				message := firstNonEmpty(event.Message, fmt.Sprintf("upstream response was incomplete (%s)", event.Reason))
				return nil, incompleteError{status: 529, message: message}
			}
		}
	}
	if !done {
		return nil, statusError{status: http.StatusBadGateway, message: "adapter stream ended without a terminal event"}
	}
	return map[string]any{"id": "msg_" + randomHex(12), "type": "message", "role": "assistant", "content": content, "model": model, "stop_reason": stop, "stop_sequence": nil, "usage": anthropicUsage(usage)}, nil
}

func appendTextBlock(content []any, kind, field, text string) []any {
	if len(content) > 0 {
		if last, ok := content[len(content)-1].(map[string]any); ok && last["type"] == kind {
			last[field] = fmt.Sprint(last[field]) + text
			return content
		}
	}
	block := map[string]any{"type": kind, field: text}
	if kind == "thinking" {
		block["signature"] = "ocx" + fmt.Sprint(time.Now().UnixMilli())
	}
	return append(content, block)
}

func writeAnthropicStream(ctx context.Context, w http.ResponseWriter, model string, events <-chan types.AdapterEvent) error {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	started, terminal, sawTool, index := false, false, false, 0
	open := ""
	var usage *types.Usage
	emit := func(name string, data any) error {
		encoded, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, encoded); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	start := func() error {
		if started {
			return nil
		}
		started = true
		if err := emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_" + randomHex(12), "type": "message", "role": "assistant", "content": []any{}, "model": model, "stop_reason": nil, "stop_sequence": nil, "usage": anthropicUsage(nil)}}); err != nil {
			return err
		}
		return emit("ping", map[string]any{"type": "ping"})
	}
	closeBlock := func() error {
		if open == "" {
			return nil
		}
		if open == "thinking" {
			_ = emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index - 1, "delta": map[string]any{"type": "signature_delta", "signature": "ocx" + fmt.Sprint(time.Now().UnixMilli())}})
		}
		err := emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index - 1})
		open = ""
		return err
	}
	for !terminal {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-events:
			if !ok {
				if err := start(); err != nil {
					return err
				}
				_ = closeBlock()
				return emit("error", anthropicErrorBody(http.StatusBadGateway, "upstream stream ended before a terminal event", "overloaded_error"))
			}
			if err := start(); err != nil {
				return err
			}
			switch event.Type {
			case types.EventTextDelta, types.EventReasoning:
				kind, deltaType, field, text := "text", "text_delta", "text", event.Text
				if event.Type == types.EventReasoning {
					kind, deltaType, field, text = "thinking", "thinking_delta", "thinking", event.Reasoning
					if text == "" {
						text = event.Text
					}
				}
				if text == "" {
					continue
				}
				if open != kind {
					if err := closeBlock(); err != nil {
						return err
					}
					block := map[string]any{"type": kind, field: ""}
					if kind == "thinking" {
						block["signature"] = ""
					}
					if err := emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": block}); err != nil {
						return err
					}
					index++
					open = kind
				}
				if err := emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index - 1, "delta": map[string]any{"type": deltaType, field: text}}); err != nil {
					return err
				}
			case types.EventToolCall:
				if event.ToolCall == nil {
					continue
				}
				if err := closeBlock(); err != nil {
					return err
				}
				sawTool = true
				call := event.ToolCall
				if err := emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": call.ID, "name": call.Name, "input": map[string]any{}}}); err != nil {
					return err
				}
				if err := emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": string(call.Arguments)}}); err != nil {
					return err
				}
				if err := emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index}); err != nil {
					return err
				}
				index++
			case types.EventUsage:
				usage = event.Usage
			case types.EventHeartbeat:
				continue
			case types.EventError:
				terminal = true
				_ = closeBlock()
				status := event.StatusCode
				if status == 0 {
					status = http.StatusBadGateway
				}
				return emit("error", anthropicErrorBody(status, firstNonEmpty(event.Error, "upstream request failed"), ""))
			case types.EventDone:
				terminal = true
				if event.Usage != nil {
					usage = event.Usage
				}
				if err := closeBlock(); err != nil {
					return err
				}
				stop := anthropicStopReason(event.StopReason)
				if sawTool {
					stop = "tool_use"
				}
				if err := emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": anthropicUsage(usage)}); err != nil {
					return err
				}
				return emit("message_stop", map[string]any{"type": "message_stop"})
			case types.EventIncomplete:
				terminal = true
				if event.Usage != nil {
					usage = event.Usage
				}
				if err := closeBlock(); err != nil {
					return err
				}
				switch event.Reason {
				case "max_output_tokens", "content_filter":
					stop := "max_tokens"
					if event.Reason == "content_filter" {
						stop = "refusal"
					}
					if err := emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil}, "usage": anthropicUsage(usage)}); err != nil {
						return err
					}
					return emit("message_stop", map[string]any{"type": "message_stop"})
				default:
					message := firstNonEmpty(event.Message, fmt.Sprintf("upstream response was incomplete (%s)", event.Reason))
					return emit("error", anthropicErrorBody(529, message, "overloaded_error"))
				}
			}
		}
	}
	return nil
}

func anthropicUsage(value *types.Usage) map[string]any {
	if value == nil {
		return map[string]any{"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
	}
	read, creation := value.CacheReadInputTokens, value.CacheCreationInputTokens
	if read == 0 {
		read = value.CachedInputTokens
	}
	input := value.InputTokens - read - creation
	if input < 0 {
		input = 0
	}
	return map[string]any{"input_tokens": input, "output_tokens": value.OutputTokens, "cache_read_input_tokens": read, "cache_creation_input_tokens": creation}
}
func anthropicStopReason(reason string) string {
	switch reason {
	case "max_output_tokens", "max_tokens", "length":
		return "max_tokens"
	case "content_filter", "refusal":
		return "refusal"
	default:
		return "end_turn"
	}
}
func anthropicErrorType(status int) string {
	switch status {
	case 400:
		return "invalid_request_error"
	case 401:
		return "authentication_error"
	case 403:
		return "permission_error"
	case 404:
		return "not_found_error"
	case 413:
		return "request_too_large"
	case 429:
		return "rate_limit_error"
	case 504:
		return "timeout_error"
	case 529:
		return "overloaded_error"
	}
	if status >= 500 {
		return "api_error"
	}
	return "invalid_request_error"
}
func anthropicErrorBody(status int, message, override string) map[string]any {
	kind := override
	if kind == "" {
		kind = anthropicErrorType(status)
	}
	return map[string]any{"type": "error", "error": map[string]any{"type": kind, "message": message}}
}
func writeAnthropicError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, anthropicErrorBody(status, message, ""))
}
func writeAnthropicErrorFor(w http.ResponseWriter, err error) {
	var incomplete incompleteError
	if errors.As(err, &incomplete) {
		writeJSON(w, incomplete.status, anthropicErrorBody(incomplete.status, incomplete.message, "overloaded_error"))
		return
	}
	var typed statusError
	if errors.As(err, &typed) {
		writeAnthropicError(w, typed.status, typed.message)
	} else {
		writeAnthropicError(w, 500, err.Error())
	}
}
