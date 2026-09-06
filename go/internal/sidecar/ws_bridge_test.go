package sidecar

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type notifiedBuffer struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	written chan struct{}
	once    sync.Once
}

func newNotifiedBuffer() *notifiedBuffer { return &notifiedBuffer{written: make(chan struct{})} }

func (b *notifiedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	n, err := b.buf.Write(p)
	b.mu.Unlock()
	b.once.Do(func() { close(b.written) })
	return n, err
}

func (b *notifiedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

func TestWSBridgeFramesSSEAndTerminal(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(SidecarBridgeHeader) != "bridge" {
			t.Fatal("bridge token missing")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"))
	}))
	defer bridge.Close()
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	bridgeWSFrames(writer, Config{ParentURL: bridge.URL, BridgeToken: "bridge"}, wsBridgeRequest{Frame: json.RawMessage("{\"type\":\"response.create\"}"), Admission: json.RawMessage("{\"kind\":\"loopback\"}")})
	_ = writer.Flush()
	reader := bufio.NewReader(&out)
	first, op, err := readServerFrame(reader)
	if err != nil || op != 1 || string(first) != "{\"type\":\"response.created\"}" {
		t.Fatalf("first=%s op=%d err=%v", first, op, err)
	}
	second, _, _ := readServerFrame(reader)
	if string(second) != "{\"type\":\"response.completed\"}" {
		t.Fatalf("second=%s", second)
	}
}

func TestWSBridgeFramesFlushesEachSSEEventBeforeUpstreamEOF(t *testing.T) {
	firstSent := make(chan struct{})
	release := make(chan struct{})
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.created\"}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		close(firstSent)
		<-release
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\"}\n\n"))
	}))
	defer bridge.Close()
	out := newNotifiedBuffer()
	writer := bufio.NewWriter(out)
	done := make(chan struct{})
	go func() {
		bridgeWSFrames(writer, Config{ParentURL: bridge.URL, BridgeToken: "bridge"}, wsBridgeRequest{Frame: json.RawMessage("{}"), Admission: json.RawMessage("{}")})
		close(done)
	}()
	<-firstSent
	select {
	case <-out.written:
	case <-time.After(time.Second):
		t.Fatal("first WebSocket frame was withheld until upstream EOF")
	}
	first, _, err := readServerFrame(bufio.NewReader(bytes.NewReader(out.Bytes())))
	if err != nil || string(first) != "{\"type\":\"response.created\"}" {
		t.Fatalf("first=%s err=%v", first, err)
	}
	close(release)
	<-done
}

func TestWSBridgeFramesReturnsAfterTerminalBeforeUpstreamEOF(t *testing.T) {
	terminalSent := make(chan struct{})
	release := make(chan struct{})
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.completed\"}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		close(terminalSent)
		<-release
	}))
	defer bridge.Close()
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	done := make(chan struct{})
	go func() {
		bridgeWSFrames(writer, Config{ParentURL: bridge.URL, BridgeToken: "bridge"}, wsBridgeRequest{Frame: json.RawMessage("{}"), Admission: json.RawMessage("{}")})
		close(done)
	}()
	<-terminalSent
	select {
	case <-done:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("bridge waited for upstream EOF after a terminal event")
	}
	close(release)
}

func TestWSSSEBlockReaderLimitsEachEventNotWholeStream(t *testing.T) {
	stream := newWSSSEBlockReader(bufio.NewReader(strings.NewReader("data: one\n\ndata: two\n\n")), 11)
	first, err := stream.Next()
	if err != nil || string(first) != "data: one" {
		t.Fatalf("first=%q err=%v", first, err)
	}
	second, err := stream.Next()
	if err != nil || string(second) != "data: two" {
		t.Fatalf("second=%q err=%v", second, err)
	}
	if _, err = stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("EOF err=%v", err)
	}
}

func TestWSSSEBlockReaderRejectsOversizeEvent(t *testing.T) {
	stream := newWSSSEBlockReader(bufio.NewReader(strings.NewReader("data: this event is too large\n\n")), 10)
	if _, err := stream.Next(); !errors.Is(err, errWSSSEBlockTooLarge) {
		t.Fatalf("err=%v", err)
	}
}

func TestWSSSEBlockReaderRejectsOversizeEOFEvent(t *testing.T) {
	stream := newWSSSEBlockReader(bufio.NewReader(strings.NewReader("data: this event is too large")), 10)
	if _, err := stream.Next(); !errors.Is(err, errWSSSEBlockTooLarge) {
		t.Fatalf("err=%v", err)
	}
}

func TestWSBridgeFramesRejectsOversizeSynthesizedJSONOutput(t *testing.T) {
	output := make([]any, maxSynthesizedOutputItems+1)
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{"output": output}); err != nil {
			t.Fatal(err)
		}
	}))
	defer bridge.Close()
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	bridgeWSFrames(writer, Config{ParentURL: bridge.URL, BridgeToken: "bridge"}, wsBridgeRequest{Frame: json.RawMessage("{}"), Admission: json.RawMessage("{}")})
	_ = writer.Flush()
	payload, _, err := readServerFrame(bufio.NewReader(&out))
	if err != nil || !bytes.Contains(payload, []byte("Responses JSON output contains 10001 items; maximum is 10000")) {
		t.Fatalf("payload=%s err=%v", payload, err)
	}
}

func TestWSBridgeFramesProtocolErrorForUnterminatedSSE(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.created\"}\n\n"))
	}))
	defer bridge.Close()
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	bridgeWSFrames(writer, Config{ParentURL: bridge.URL, BridgeToken: "bridge"}, wsBridgeRequest{Frame: json.RawMessage("{}"), Admission: json.RawMessage("{}")})
	_ = writer.Flush()
	reader := bufio.NewReader(&out)
	_, _, _ = readServerFrame(reader)
	last, _, _ := readServerFrame(reader)
	if !bytes.Contains(last, []byte("websocket_protocol_error")) {
		t.Fatalf("error=%s", last)
	}
}

func TestWSBridgeFramesUpstreamErrorAndHeaders(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(429)
		_, _ = w.Write([]byte("{\"error\":{\"type\":\"rate_limit_error\"}"))
	}))
	defer bridge.Close()
	var out bytes.Buffer
	writer := bufio.NewWriter(&out)
	bridgeWSFrames(writer, Config{ParentURL: bridge.URL, BridgeToken: "bridge"}, wsBridgeRequest{Frame: json.RawMessage("{}"), Admission: json.RawMessage("{}")})
	_ = writer.Flush()
	p, _, _ := readServerFrame(bufio.NewReader(&out))
	if !bytes.Contains(p, []byte("\"status\":429")) || !bytes.Contains(p, []byte("\"retry-after\":\"2\"")) {
		t.Fatalf("error=%s", p)
	}
}

func TestWSBridgeFrameLimit(t *testing.T) {
	if _, _, err := readWSFrame(bufio.NewReader(bytes.NewReader([]byte{0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 1}))); err == nil {
		t.Fatal("unmasked frame accepted")
	}
}
func readServerFrame(r *bufio.Reader) ([]byte, byte, error) {
	h, e := r.ReadByte()
	if e != nil {
		return nil, 0, e
	}
	n, e := r.ReadByte()
	if e != nil {
		return nil, 0, e
	}
	l := int(n)
	if l == 126 {
		a, _ := r.ReadByte()
		b, _ := r.ReadByte()
		l = int(a)<<8 | int(b)
	}
	p := make([]byte, l)
	_, e = r.Read(p)
	return p, h & 15, e
}
