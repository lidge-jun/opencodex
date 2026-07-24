package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// Event is one OpenAI Responses protocol event.
type Event struct {
	Type string         `json:"type"`
	Data map[string]any `json:"-"`
}

// Response is the buffered form of a bridged Responses stream.
type Response struct {
	ID        string           `json:"id"`
	Object    string           `json:"object"`
	CreatedAt int64            `json:"created_at"`
	Status    string           `json:"status"`
	Model     string           `json:"model"`
	Output    []map[string]any `json:"output"`
	Usage     map[string]any   `json:"usage"`
	Error     map[string]any   `json:"error,omitempty"`
}

type machine struct {
	response Response
	sequence int
	current  *openItem
	terminal bool
	usage    *types.Usage
}

type openItem struct {
	kind, id, callID, name string
	index                  int
	text                   strings.Builder
}

// StreamOptions supplies terminal usage recording metadata without coupling the
// bridge to a concrete persistence implementation.
type StreamOptions struct {
	Recorder types.UsageRecorder
	Record   *types.UsageRecord
}

// Convert consumes adapter events and returns ordered Responses events and the final response.
func Convert(model string, events []types.AdapterEvent) ([]Event, Response) {
	m := newMachine(model)
	out := []Event{m.emit("response.created", map[string]any{"response": m.snapshot("in_progress")})}
	for _, event := range events {
		out = append(out, m.accept(event)...)
	}
	if !m.terminal {
		out = append(out, m.finish("incomplete", "adapter stream ended without terminal event")...)
	}
	return out, m.response
}

// Stream converts an adapter channel to SSE. It always emits one protocol terminal and [DONE].
func Stream(ctx context.Context, w io.Writer, model string, events <-chan types.AdapterEvent) error {
	return StreamWithOptions(ctx, w, model, events, StreamOptions{})
}

// StreamWithOptions converts an adapter channel to SSE and records provider
// usage after the protocol terminal has been emitted.
func StreamWithOptions(ctx context.Context, w io.Writer, model string, events <-chan types.AdapterEvent, options StreamOptions) error {
	m := newMachine(model)
	if err := writeSSE(w, m.emit("response.created", map[string]any{"response": m.snapshot("in_progress")})); err != nil {
		return err
	}
	for !m.terminal {
		select {
		case <-ctx.Done():
			for _, event := range m.finish("incomplete", ctx.Err().Error()) {
				if err := writeSSE(w, event); err != nil {
					return err
				}
			}
		case event, ok := <-events:
			if !ok {
				for _, tail := range m.finish("incomplete", "adapter stream ended without terminal event") {
					if err := writeSSE(w, tail); err != nil {
						return err
					}
				}
				break
			}
			for _, bridged := range m.accept(event) {
				if err := writeSSE(w, bridged); err != nil {
					return err
				}
			}
		}
	}
	_, err := io.WriteString(w, "data: [DONE]\n\n")
	if err == nil {
		recordStreamUsage(ctx, m, options)
	}
	return err
}

func recordStreamUsage(ctx context.Context, m *machine, options StreamOptions) {
	if options.Recorder == nil || options.Record == nil || m.usage == nil {
		return
	}
	record := *options.Record
	record.Usage = *m.usage
	record.Duration = time.Since(record.StartedAt)
	switch {
	case ctx.Err() != nil:
		record.Status = types.OutcomeCancelled
	case m.response.Status == "completed":
		record.Status = types.OutcomeSuccess
	default:
		record.Status = types.OutcomeProviderError
	}
	_ = options.Recorder.Record(context.WithoutCancel(ctx), &record)
}

// Buffered consumes an adapter channel and returns the JSON response representation.
func Buffered(ctx context.Context, model string, events <-chan types.AdapterEvent) (Response, error) {
	collected := make([]types.AdapterEvent, 0, 16)
	for {
		select {
		case <-ctx.Done():
			return Response{}, ctx.Err()
		case event, ok := <-events:
			if !ok {
				_, response := Convert(model, collected)
				return response, nil
			}
			collected = append(collected, event)
			if event.Type == types.EventDone || event.Type == types.EventError {
				_, response := Convert(model, collected)
				return response, nil
			}
		}
	}
}

func newMachine(model string) *machine {
	idBytes := make([]byte, 12)
	_, _ = rand.Read(idBytes)
	return &machine{response: Response{ID: "resp_" + hex.EncodeToString(idBytes), Object: "response", CreatedAt: time.Now().Unix(), Status: "in_progress", Model: model, Output: []map[string]any{}, Usage: usage(nil)}}
}

func (m *machine) accept(event types.AdapterEvent) []Event {
	if m.terminal {
		return nil
	}
	var out []Event
	switch event.Type {
	case types.EventTextDelta:
		out = append(out, m.ensureItem("message", "msg_")...)
		m.current.text.WriteString(event.Text)
		out = append(out, m.emit("response.output_text.delta", map[string]any{"item_id": m.current.id, "output_index": m.current.index, "content_index": 0, "delta": event.Text}))
	case types.EventReasoning:
		out = append(out, m.ensureItem("reasoning", "rs_")...)
		delta := event.Reasoning
		if delta == "" {
			delta = event.Text
		}
		m.current.text.WriteString(delta)
		out = append(out, m.emit("response.reasoning_summary_text.delta", map[string]any{"item_id": m.current.id, "output_index": m.current.index, "summary_index": 0, "delta": delta}))
	case types.EventToolCall:
		if event.ToolCall == nil {
			break
		}
		callID := event.ToolCall.ID
		if callID == "" {
			callID = "call_" + randomID()
		}
		if m.current == nil || m.current.kind != "tool" || m.current.callID != callID {
			out = append(out, m.closeCurrent()...)
			m.current = &openItem{kind: "tool", id: "fc_" + randomID(), callID: callID, name: event.ToolCall.Name, index: len(m.response.Output)}
			item := map[string]any{"type": "function_call", "id": m.current.id, "call_id": callID, "name": event.ToolCall.Name, "arguments": "", "status": "in_progress"}
			out = append(out, m.emit("response.output_item.added", map[string]any{"output_index": m.current.index, "item": item}))
		}
		chunk := string(event.ToolCall.Arguments)
		m.current.text.WriteString(chunk)
		out = append(out, m.emit("response.function_call_arguments.delta", map[string]any{"item_id": m.current.id, "output_index": m.current.index, "delta": chunk}))
	case types.EventUsage:
		m.usage = cloneUsage(event.Usage)
		m.response.Usage = usage(event.Usage)
	case types.EventDone:
		if event.Usage != nil {
			m.usage = cloneUsage(event.Usage)
			m.response.Usage = usage(event.Usage)
		}
		out = append(out, m.finish("completed", "")...)
	case types.EventError:
		message := event.Error
		if message == "" {
			message = "provider error"
		}
		out = append(out, m.finish("failed", message)...)
	}
	return out
}

func cloneUsage(value *types.Usage) *types.Usage {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func (m *machine) ensureItem(kind, prefix string) []Event {
	if m.current != nil && m.current.kind == kind {
		return nil
	}
	out := m.closeCurrent()
	m.current = &openItem{kind: kind, id: prefix + randomID(), index: len(m.response.Output)}
	var item map[string]any
	if kind == "message" {
		item = map[string]any{"type": "message", "id": m.current.id, "status": "in_progress", "role": "assistant", "content": []any{}}
	} else {
		item = map[string]any{"type": "reasoning", "id": m.current.id, "summary": []any{}}
	}
	return append(out, m.emit("response.output_item.added", map[string]any{"output_index": m.current.index, "item": item}))
}

func (m *machine) closeCurrent() []Event {
	if m.current == nil {
		return nil
	}
	item, text := m.current, m.current.text.String()
	var out []Event
	var final map[string]any
	switch item.kind {
	case "message":
		out = append(out,
			m.emit("response.output_text.done", map[string]any{"item_id": item.id, "output_index": item.index, "content_index": 0, "text": text}),
			m.emit("response.content_part.done", map[string]any{"item_id": item.id, "output_index": item.index, "content_index": 0, "part": map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}),
		)
		final = map[string]any{"type": "message", "id": item.id, "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
	case "reasoning":
		out = append(out, m.emit("response.reasoning_summary_text.done", map[string]any{"item_id": item.id, "output_index": item.index, "summary_index": 0, "text": text}))
		final = map[string]any{"type": "reasoning", "id": item.id, "summary": []any{map[string]any{"type": "summary_text", "text": text}}}
	case "tool":
		if text == "" {
			text = "{}"
		}
		out = append(out, m.emit("response.function_call_arguments.done", map[string]any{"item_id": item.id, "output_index": item.index, "arguments": text}))
		final = map[string]any{"type": "function_call", "id": item.id, "call_id": item.callID, "name": item.name, "arguments": text, "status": "completed"}
	}
	if final != nil {
		m.response.Output = append(m.response.Output, final)
		out = append(out, m.emit("response.output_item.done", map[string]any{"output_index": item.index, "item": final}))
	}
	m.current = nil
	return out
}

func (m *machine) finish(status, message string) []Event {
	if m.terminal {
		return nil
	}
	out := m.closeCurrent()
	m.terminal, m.response.Status = true, status
	if status == "failed" || status == "incomplete" {
		m.response.Error = map[string]any{"type": "server_error", "message": message}
	}
	eventType := "response." + status
	out = append(out, m.emit(eventType, map[string]any{"response": m.snapshot(status)}))
	return out
}

func (m *machine) snapshot(status string) map[string]any {
	result := map[string]any{"id": m.response.ID, "object": "response", "created_at": m.response.CreatedAt, "status": status, "model": m.response.Model, "output": m.response.Output, "usage": m.response.Usage}
	if m.response.Error != nil {
		result["error"] = m.response.Error
	}
	return result
}

func (m *machine) emit(kind string, data map[string]any) Event {
	data["sequence_number"] = m.sequence
	m.sequence++
	return Event{Type: kind, Data: data}
}

func writeSSE(w io.Writer, event Event) error {
	payload := make(map[string]any, len(event.Data)+1)
	for key, value := range event.Data {
		payload[key] = value
	}
	payload["type"] = event.Type
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
	return err
}

func usage(value *types.Usage) map[string]any {
	if value == nil {
		return map[string]any{"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
	}
	total := value.TotalTokens
	if total == 0 {
		total = value.InputTokens + value.OutputTokens
	}
	return map[string]any{"input_tokens": value.InputTokens, "output_tokens": value.OutputTokens, "total_tokens": total}
}

func randomID() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
