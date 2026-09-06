package sidecar

// Incremental Responses SSE rewrite and terminal boundary for ticket #29.
//
// The direct streaming relay needs the same two guarantees as the TypeScript
// passthrough path: sparse Responses events are repaired before a strict
// client sees them, and a Responses terminal is a protocol boundary even when
// an upstream keeps its HTTP connection open. This file owns only the
// byte-stream state machine; relay wiring remains in the caller.

import (
	"bytes"
	"errors"
	"math"
	"strconv"
	"sync/atomic"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

const maxResponsesSSEBlockBytes = 4 * 1024 * 1024

var errResponsesSSEBlockTooLarge = errors.New("Responses SSE block exceeds maximum size")

var adapterEOFIncompletePayload = []byte("{\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"adapter_eof\"}}}")

// syntheticSSEItemOrdinal follows the stateless TypeScript rewrite: malformed
// output indices get a process-global, lexically separate fallback namespace.
// Atomic increment keeps independently relayed streams race-free.
var syntheticSSEItemOrdinal atomic.Int64

// ResponsesSSEStream incrementally frames, repairs, and terminal-bounds one
// Responses SSE stream. Feed accepts arbitrary transport chunks; its output
// contains only complete client-dispatchable SSE events. Finish must be called
// once on clean upstream EOF to dispatch an unterminated final event and, if
// no Responses terminal was observed, synthesize adapter_eof plus [DONE].
type ResponsesSSEStream struct {
	buffer      []byte
	terminal    bool
	done        bool
	pendingDone []sseFrame
	pipeline    responseRepairPipeline
}

type sseFrame struct {
	block     []byte
	delimiter []byte
}

// NewResponsesSSEStream creates a stream-local state machine. Do not share one
// instance between concurrent upstream Responses requests.
func NewResponsesSSEStream(pipeline ...responseRepairPipeline) *ResponsesSSEStream {
	s := &ResponsesSSEStream{}
	if len(pipeline) > 0 {
		s.pipeline = pipeline[0]
	}
	return s
}

// TerminalSeen reports whether a response.completed, response.failed, or
// response.incomplete event crossed the client boundary.
func (s *ResponsesSSEStream) TerminalSeen() bool { return s.terminal }

// DoneSeen reports whether upstream supplied any [DONE] data event. A [DONE]
// before a Responses terminal is held until a terminal arrives.
func (s *ResponsesSSEStream) DoneSeen() bool { return s.done }

// Feed processes arbitrary upstream bytes. Once the first Responses terminal
// has been seen, future chunks are ignored. Frames already in this call retain
// the TS boundary behavior: later ordinary events are dropped but later [DONE]
// frames are retained.
func (s *ResponsesSSEStream) Feed(chunk []byte) ([]byte, error) {
	if s.terminal || len(chunk) == 0 {
		return nil, nil
	}
	s.buffer = append(s.buffer, chunk...)
	var out bytes.Buffer
	for {
		at, delimiterLen, incomplete := sseDelimiter(s.buffer)
		if incomplete || at < 0 {
			if len(s.buffer) > maxResponsesSSEBlockBytes {
				return nil, errResponsesSSEBlockTooLarge
			}
			break
		}
		frame := sseFrame{
			block:     append([]byte(nil), s.buffer[:at]...),
			delimiter: append([]byte(nil), s.buffer[at:at+delimiterLen]...),
		}
		s.buffer = append(s.buffer[:0], s.buffer[at+delimiterLen:]...)
		s.processFrame(&out, frame)
	}
	return out.Bytes(), nil
}

// Finish closes a clean upstream stream. An incomplete final frame receives a
// synthetic blank-line delimiter before rewriting so clients can dispatch it.
func (s *ResponsesSSEStream) Finish() ([]byte, error) {
	var out bytes.Buffer
	_, err := s.finishPartial(&out)
	if err != nil {
		return nil, err
	}
	if s.terminal {
		if !s.done {
			out.WriteString("data: [DONE]\n\n")
		}
		return out.Bytes(), nil
	}
	out.WriteString("event: response.incomplete\ndata: ")
	out.Write(adapterEOFIncompletePayload)
	out.WriteString("\n\n")
	out.WriteString("data: [DONE]\n\n")
	return out.Bytes(), nil
}

// FinishPartial synthetically delimits and rewrites the retained tail without
// inventing an adapter_eof terminal or [DONE]. Use it on an upstream read error
// before the relay writes its response.failed tail.
func (s *ResponsesSSEStream) FinishPartial() ([]byte, error) {
	var out bytes.Buffer
	_, err := s.finishPartial(&out)
	return out.Bytes(), err
}

func (s *ResponsesSSEStream) finishPartial(out *bytes.Buffer) (bool, error) {
	if s.terminal {
		return true, nil
	}
	if len(s.buffer) == 0 {
		return false, nil
	}
	delimiter := []byte("\n\n")
	if bytes.Contains(s.buffer, []byte("\r\n")) {
		delimiter = []byte("\r\n\r\n")
	}
	frame := sseFrame{block: append([]byte(nil), s.buffer...), delimiter: delimiter}
	s.buffer = nil
	s.processFrame(out, frame)
	return s.terminal, nil
}

func (s *ResponsesSSEStream) processFrame(out *bytes.Buffer, frame sseFrame) {
	payload, hasData := sseDataPayloadBytes(frame.block)
	if hasData && string(payload) == "[DONE]" {
		s.done = true
		if s.terminal {
			out.Write(frame.block)
			out.Write(frame.delimiter)
		} else if s.pendingDone == nil {
			s.pendingDone = []sseFrame{frame}
		}
		return
	}
	if s.terminal {
		return
	}
	rewritten := s.rewriteBlock(frame.block, payload, hasData)
	out.Write(rewritten)
	out.Write(frame.delimiter)
	if hasData && responsesSSETerminal(payload) {
		s.terminal = true
		for _, pending := range s.pendingDone {
			out.Write(pending.block)
			out.Write(pending.delimiter)
		}
		s.pendingDone = nil
	}
}

// sseDelimiter finds the first valid SSE blank-line delimiter. incomplete is
// true when the buffer ends inside a candidate delimiter.
func sseDelimiter(data []byte) (at, length int, incomplete bool) {
	for i := 0; i < len(data); i++ {
		if data[i] == '\n' {
			if i+1 == len(data) {
				return -1, 0, true
			}
			if data[i+1] == '\n' {
				return i, 2, false
			}
			if data[i+1] == '\r' {
				if i+2 == len(data) {
					return -1, 0, true
				}
				if data[i+2] == '\n' {
					return i, 3, false
				}
			}
		}
		if data[i] == '\r' && i+1 < len(data) && data[i+1] == '\n' {
			if i+2 == len(data) {
				return -1, 0, true
			}
			if data[i+2] == '\n' {
				return i, 3, false
			}
			if data[i+2] == '\r' {
				if i+3 == len(data) {
					return -1, 0, true
				}
				if data[i+3] == '\n' {
					return i, 4, false
				}
			}
		}
	}
	return -1, 0, false
}

func sseDataPayloadBytes(block []byte) ([]byte, bool) {
	var payload []byte
	found := false
	for _, line := range bytes.Split(block, []byte("\n")) {
		line = bytes.TrimSuffix(line, []byte("\r"))
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		value := line[len("data:"):]
		if len(value) > 0 && value[0] == ' ' {
			value = value[1:]
		}
		if found {
			payload = append(payload, '\n')
		}
		payload = append(payload, value...)
		found = true
	}
	return payload, found
}

func (s *ResponsesSSEStream) rewriteBlock(block, payload []byte, hasData bool) []byte {
	if !hasData {
		return block
	}
	event, err := jsonwire.Parse(payload)
	if err != nil || event.Kind() != jsonwire.Object {
		return block
	}
	changed := s.pipeline.repairPayload(event)
	changed = s.rewriteEvent(event) || changed
	if !changed {
		return block
	}
	encoded, err := event.Encode()
	if err != nil {
		return block
	}
	return replaceSSEDataPayload(block, encoded)
}

func (s *ResponsesSSEStream) rewriteEvent(event *jsonwire.Value) bool {
	typeName, _ := stringMember(event, "type")
	inferred := inferredSSEItemStatus(typeName)
	changed := false
	if typeName == "response.output_item.added" || typeName == "response.output_item.done" {
		if item := event.Find("item"); item != nil && item.Kind() == jsonwire.Object {
			index, ok := sseOutputIndex(event.Find("output_index"))
			if !ok {
				slot := "fallback_" + strconv.FormatInt(syntheticSSEItemOrdinal.Add(1), 10)
				changed = backfillSSEOutputItem(item, slot, inferred) || changed
			} else {
				changed = backfillSSEOutputItem(item, index, inferred) || changed
			}
		}
	}
	if typeName == "response.content_part.added" || typeName == "response.content_part.done" {
		if _, repaired := backfillOutputTextPart(event.Find("part")); repaired {
			changed = true
		}
	}
	if response := event.Find("response"); response != nil && response.Kind() == jsonwire.Object {
		responseStatus := inferred
		if raw, ok := stringMember(response, "status"); ok {
			if mapped, ok := responseStatusToItemStatus(raw); ok {
				responseStatus = mapped
			}
		}
		if output := response.Find("output"); output != nil && output.Kind() == jsonwire.Array {
			for index, item := range output.Elements() {
				changed = backfillSSEOutputItem(item, itoa(index), responseStatus) || changed
			}
		}
	}
	return changed
}

func inferredSSEItemStatus(typeName string) string {
	switch typeName {
	case "response.output_item.added", "response.created", "response.in_progress", "response.queued":
		return "in_progress"
	case "response.incomplete", "response.failed":
		return "incomplete"
	default:
		return "completed"
	}
}

func sseOutputIndex(value *jsonwire.Value) (string, bool) {
	if value == nil || value.Kind() != jsonwire.Number {
		return "", false
	}
	parsed, err := strconv.ParseFloat(value.NumberRaw(), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || math.Trunc(parsed) != parsed {
		return "", false
	}
	return jsonwire.FormatV8Number(parsed), true
}

func backfillSSEOutputItem(item *jsonwire.Value, slot, inferredStatus string) bool {
	if item == nil || item.Kind() != jsonwire.Object {
		return false
	}
	typeName, _ := stringMember(item, "type")
	if compactionItemTypes[typeName] {
		return false
	}
	changed := backfillContentArray(item.Find("content"))
	if id := item.Find("id"); id == nil || id.Kind() != jsonwire.String || id.String() == "" {
		prefix, ok := responsesItemIDPrefixes[typeName]
		if !ok {
			prefix = "item_"
		}
		item.Set("id", jsonwire.StringValue(prefix+"ocx_"+slot))
		changed = true
	}
	changed = backfillItemStatus(item, inferredStatus) || changed
	return changed
}

func responsesSSETerminal(payload []byte) bool {
	event, err := jsonwire.Parse(payload)
	if err != nil || event.Kind() != jsonwire.Object {
		return false
	}
	typeName, _ := stringMember(event, "type")
	return typeName == "response.completed" || typeName == "response.failed" || typeName == "response.incomplete"
}

func replaceSSEDataPayload(block, payload []byte) []byte {
	newline := []byte("\n")
	if bytes.Contains(block, []byte("\r\n")) {
		newline = []byte("\r\n")
	}
	lines := bytes.Split(block, []byte("\n"))
	var out bytes.Buffer
	replaced := false
	for index, original := range lines {
		line := bytes.TrimSuffix(original, []byte("\r"))
		if index > 0 {
			out.Write(newline)
		}
		if bytes.HasPrefix(line, []byte("data:")) {
			if !replaced {
				out.WriteString("data: ")
				out.Write(payload)
				replaced = true
			}
			continue
		}
		out.Write(line)
	}
	if !replaced {
		return block
	}
	return out.Bytes()
}
