package sidecar

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
