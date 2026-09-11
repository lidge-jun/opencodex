package responsesrelay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const maxSSEBlockBytes = 4 * 1024 * 1024

var (
	ErrSSEBlockTooLarge = errors.New("responsesrelay: SSE event exceeds block limit")
	ErrSSEUnterminated  = errors.New("responsesrelay: unterminated SSE event")
	ErrSSEInvalidJSON   = errors.New("responsesrelay: SSE data is not valid JSON")
)

type ToolCall struct {
	ID        string
	CallID    string
	Name      string
	Arguments string
}

// Event is a parsed view over one complete SSE event. Raw is the original
// block, including its delimiter, so relays can forward it without loss.
type Event struct {
	Raw  []byte
	Name string
	Data []byte
}

type StreamResult struct {
	Events    int
	Completed bool
	Failed    bool
	Usage     json.RawMessage
	ToolCalls []ToolCall
}

// Stream incrementally validates and observes a Responses SSE stream while
// returning every accepted event unchanged. It never synthesizes or rewrites
// tool calls, usage, or terminal payloads.
type Stream struct {
	buffer   []byte
	result   StreamResult
	terminal bool
}

func NewStream() *Stream { return &Stream{} }

func (s *Stream) Result() StreamResult {
	result := s.result
	result.Usage = append(json.RawMessage(nil), result.Usage...)
	result.ToolCalls = append([]ToolCall(nil), result.ToolCalls...)
	return result
}

// Feed accepts arbitrary transport chunks and returns only complete event
// blocks. An invalid event is rejected before its bytes are returned.
func (s *Stream) Feed(chunk []byte) ([]byte, error) {
	s.buffer = append(s.buffer, chunk...)
	var out bytes.Buffer
	for {
		end := sseDelimiter(s.buffer)
		if end < 0 {
			if len(s.buffer) > maxSSEBlockBytes {
				return nil, ErrSSEBlockTooLarge
			}
			break
		}
		block := append([]byte(nil), s.buffer[:end]...)
		s.buffer = s.buffer[end:]
		if err := s.accept(block); err != nil {
			return nil, err
		}
		out.Write(block)
	}
	return out.Bytes(), nil
}

func (s *Stream) Finish() ([]byte, error) {
	if len(s.buffer) != 0 {
		return nil, ErrSSEUnterminated
	}
	if !s.terminal {
		return nil, errors.New("responsesrelay: SSE stream ended without a terminal event")
	}
	return nil, nil
}

// RelaySSE validates and forwards an upstream SSE body. It flushes each
// complete event to dst and observes usage/tool calls for the caller.
func RelaySSE(ctx context.Context, src io.Reader, dst io.Writer) (StreamResult, error) {
	if src == nil || dst == nil {
		return StreamResult{}, errors.New("responsesrelay: nil SSE source or destination")
	}
	stream := NewStream()
	reader := bufio.NewReader(src)
	for {
		if err := contextErr(ctx); err != nil {
			return stream.Result(), err
		}
		chunk := make([]byte, 32*1024)
		n, err := reader.Read(chunk)
		if n > 0 {
			out, feedErr := stream.Feed(chunk[:n])
			if feedErr != nil {
				return stream.Result(), feedErr
			}
			if len(out) > 0 {
				if _, writeErr := dst.Write(out); writeErr != nil {
					return stream.Result(), writeErr
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				_, finishErr := stream.Finish()
				return stream.Result(), finishErr
			}
			return stream.Result(), err
		}
	}
}

func (s *Stream) accept(block []byte) error {
	if len(block) > maxSSEBlockBytes {
		return ErrSSEBlockTooLarge
	}
	event, err := parseEvent(block)
	if err != nil {
		return err
	}
	if event.Data == nil {
		return nil // comment/empty event
	}
	if s.terminal {
		return errors.New("responsesrelay: event follows terminal event")
	}
	if bytes.Equal(bytes.TrimSpace(event.Data), []byte("[DONE]")) {
		s.terminal = true
		s.result.Events++
		s.result.Completed = true
		return nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(event.Data, &payload); err != nil {
		return fmt.Errorf("%w: %v", ErrSSEInvalidJSON, err)
	}
	s.result.Events++
	if value, ok := payload["usage"]; ok {
		s.result.Usage = append(json.RawMessage(nil), value...)
	}
	if response, ok := payload["response"]; ok {
		var nested map[string]json.RawMessage
		if json.Unmarshal(response, &nested) == nil {
			if value, present := nested["usage"]; present {
				s.result.Usage = append(json.RawMessage(nil), value...)
			}
		}
	}
	s.observeToolCall(payload)
	typ := event.Name
	if typ == "" {
		_ = json.Unmarshal(payload["type"], &typ)
	}
	switch typ {
	case "response.completed":
		s.terminal, s.result.Completed = true, true
	case "response.failed", "response.incomplete":
		s.terminal, s.result.Failed = true, true
	}
	return nil
}

func (s *Stream) observeToolCall(payload map[string]json.RawMessage) {
	item := payload["item"]
	if item == nil {
		return
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(item, &raw) != nil {
		return
	}
	var typ, id, callID, name, args string
	_ = json.Unmarshal(raw["type"], &typ)
	if typ != "function_call" && typ != "custom_tool_call" {
		return
	}
	_ = json.Unmarshal(raw["id"], &id)
	_ = json.Unmarshal(raw["call_id"], &callID)
	_ = json.Unmarshal(raw["name"], &name)
	_ = json.Unmarshal(raw["arguments"], &args)
	s.result.ToolCalls = append(s.result.ToolCalls, ToolCall{ID: id, CallID: callID, Name: name, Arguments: args})
}

func parseEvent(block []byte) (Event, error) {
	event := Event{Raw: append([]byte(nil), block...)}
	lines := strings.Split(strings.ReplaceAll(string(block), "\r\n", "\n"), "\n")
	var data []string
	for _, line := range lines {
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		key, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		switch key {
		case "event":
			event.Name = value
		case "data":
			data = append(data, value)
		}
	}
	if len(data) > 0 {
		event.Data = []byte(strings.Join(data, "\n"))
	}
	return event, nil
}

func sseDelimiter(buffer []byte) int {
	for i := 0; i < len(buffer); i++ {
		if buffer[i] == '\n' && i+1 < len(buffer) && buffer[i+1] == '\n' {
			return i + 2
		}
		if buffer[i] == '\r' && i+3 < len(buffer) && buffer[i+1] == '\n' && buffer[i+2] == '\r' && buffer[i+3] == '\n' {
			return i + 4
		}
	}
	return -1
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}
