package sidecar

// Responses WebSocket bridge (ticket #28). Bun retains the public socket; it
// invokes this loopback, token-gated endpoint per turn so Go produces frames.
import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const (
	ResponsesWSBridgePath       = "/v1/responses/ws-bridge"
	ResponsesWSParentBridgePath = "/__ocx_go_sidecar/responses-ws"
	maxWSFrameBytes             = 50 * 1024 * 1024
)

type wsBridgeRequest struct {
	Frame     json.RawMessage `json:"frame"`
	Admission json.RawMessage `json:"admission"`
}

func mountResponsesWebSocketBridge(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc(ResponsesWSBridgePath, func(w http.ResponseWriter, r *http.Request) {
		if cfg.RequestToken == "" || !managementauth.EqualSecret(r.Header.Get(SidecarRequestHeader), cfg.RequestToken) || r.Method != http.MethodGet || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.NotFound(w, r)
			return
		}
		if cfg.BridgeToken == "" {
			http.NotFound(w, r)
			return
		}
		key := r.Header.Get("Sec-WebSocket-Key")
		if key == "" || !strings.EqualFold(r.Header.Get("Sec-WebSocket-Version"), "13") {
			http.Error(w, "websocket upgrade required", http.StatusUpgradeRequired)
			return
		}
		h, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "websocket unavailable", http.StatusInternalServerError)
			return
		}
		conn, rw, err := h.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		if _, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + websocketAccept(key) + "\r\n\r\n"); err != nil {
			return
		}
		if rw.Flush() != nil {
			return
		}
		payload, opcode, err := readWSFrame(rw.Reader)
		if err != nil || opcode != 1 {
			return
		}
		var input wsBridgeRequest
		if json.Unmarshal(payload, &input) != nil || len(input.Frame) == 0 || len(input.Admission) == 0 {
			sendWSError(rw.Writer, 400, map[string]any{"type": "invalid_request_error", "message": "invalid WebSocket bridge request"}, nil)
			_ = rw.Flush()
			return
		}
		bridgeWSFrames(rw.Writer, cfg, input)
		_ = rw.Flush()
		_, _ = rw.Write([]byte{0x88, 0x00})
		_ = rw.Flush()
	})
}

func websocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}
func readWSFrame(r *bufio.Reader) ([]byte, byte, error) {
	h, err := r.ReadByte()
	if err != nil {
		return nil, 0, err
	}
	op := h & 15
	second, err := r.ReadByte()
	if err != nil {
		return nil, 0, err
	}
	if second&128 == 0 {
		return nil, 0, io.ErrUnexpectedEOF
	}
	n := uint64(second & 127)
	if n == 126 {
		var b [2]byte
		if _, err = io.ReadFull(r, b[:]); err != nil {
			return nil, 0, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	} else if n == 127 {
		var b [8]byte
		if _, err = io.ReadFull(r, b[:]); err != nil {
			return nil, 0, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > maxWSFrameBytes {
		return nil, 0, io.ErrShortBuffer
	}
	var mask [4]byte
	if _, err = io.ReadFull(r, mask[:]); err != nil {
		return nil, 0, err
	}
	p := make([]byte, n)
	if _, err = io.ReadFull(r, p); err != nil {
		return nil, 0, err
	}
	for i := range p {
		p[i] ^= mask[i%4]
	}
	return p, op, nil
}
func writeWSText(w *bufio.Writer, p []byte) error {
	if len(p) > maxWSFrameBytes {
		return io.ErrShortBuffer
	}
	h := []byte{129}
	n := len(p)
	if n < 126 {
		h = append(h, byte(n))
	} else if n <= 65535 {
		h = append(h, 126, byte(n>>8), byte(n))
	} else {
		h = append(h, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	if _, e := w.Write(h); e != nil {
		return e
	}
	_, e := w.Write(p)
	return e
}
func safeWSHeaders(h http.Header) map[string]string {
	o := map[string]string{}
	for k, v := range h {
		l := strings.ToLower(k)
		if l == "retry-after" || l == "x-request-id" || l == "openai-request-id" || l == "x-codex-turn-state" || l == "openai-model" || l == "x-models-etag" || l == "x-reasoning-included" || strings.HasPrefix(l, "x-ratelimit-") {
			o[l] = strings.Join(v, ",")
		}
	}
	return o
}
func sendWSError(w *bufio.Writer, status int, e map[string]any, h map[string]string) {
	if h == nil {
		h = map[string]string{}
	}
	b, _ := json.Marshal(map[string]any{"type": "error", "status": status, "error": e, "headers": h})
	_ = writeWSText(w, b)
}
func protocolWSError(w *bufio.Writer, m string) {
	sendWSError(w, 502, map[string]any{"type": "protocol_error", "code": "websocket_protocol_error", "message": m}, nil)
}

func bridgeWSFrames(w *bufio.Writer, cfg Config, input wsBridgeRequest) {
	parent, ok := privateParentBridgeURL(cfg.ParentURL, ResponsesWSParentBridgePath)
	if !ok {
		sendWSError(w, 503, map[string]any{"type": "server_error", "message": "responses bridge unavailable"}, nil)
		return
	}
	body, _ := json.Marshal(input)
	req, e := http.NewRequest(http.MethodPost, parent.String(), bytes.NewReader(body))
	if e != nil {
		sendWSError(w, 503, map[string]any{"type": "server_error", "message": "responses bridge unavailable"}, nil)
		return
	}
	req.Header.Set(SidecarBridgeHeader, cfg.BridgeToken)
	req.Header.Set("Content-Type", "application/json")
	resp, e := dataPlaneBridgeClient().Do(req)
	if e != nil {
		sendWSError(w, 503, map[string]any{"type": "server_error", "message": "responses bridge unavailable"}, nil)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
		errBody := map[string]any{"type": "upstream_error", "message": strings.TrimSpace(string(raw))}
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) == nil {
			if v, yes := parsed["error"].(map[string]any); yes {
				errBody = v
			}
		}
		sendWSError(w, resp.StatusCode, errBody, safeWSHeaders(resp.Header))
		return
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "application/json") {
		var v map[string]any
		if json.NewDecoder(resp.Body).Decode(&v) != nil {
			protocolWSError(w, "Invalid JSON payload in upstream response")
			return
		}
		sendJSONEvents(w, v)
		return
	}
	data, e := io.ReadAll(io.LimitReader(resp.Body, maxWSFrameBytes+1))
	if e != nil || len(data) > maxWSFrameBytes {
		protocolWSError(w, "Upstream stream exceeds WebSocket frame limit")
		return
	}
	if !strings.Contains(ct, "text/event-stream") && !looksSSE(data) {
		protocolWSError(w, "Unexpected successful non-SSE upstream response ("+ct+")")
		return
	}
	terminal := false
	for _, block := range splitSSE(data) {
		p := sseData(block)
		if p == "" || p == "[DONE]" {
			continue
		}
		var v map[string]any
		if json.Unmarshal([]byte(p), &v) != nil {
			protocolWSError(w, "Invalid JSON payload in upstream SSE frame")
			return
		}
		if terminal {
			continue
		}
		_ = writeWSText(w, []byte(p))
		typ, _ := v["type"].(string)
		if typ == "response.completed" || typ == "response.failed" || typ == "response.incomplete" {
			terminal = true
		}
	}
	if !terminal {
		protocolWSError(w, "Upstream stream ended before response terminal event")
	}
}
func looksSSE(b []byte) bool {
	s := strings.TrimSpace(string(b))
	return strings.HasPrefix(s, "data:") || strings.HasPrefix(s, "event:")
}
func splitSSE(b []byte) []string {
	return strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n\n")
}
func sseData(block string) string {
	var a []string
	for _, l := range strings.Split(block, "\n") {
		if strings.HasPrefix(l, "data:") {
			a = append(a, strings.TrimPrefix(strings.TrimPrefix(l, "data:"), " "))
		}
	}
	return strings.Join(a, "\n")
}
func sendJSONEvents(w *bufio.Writer, r map[string]any) {
	status, _ := r["status"].(string)
	if status != "failed" && status != "incomplete" {
		status = "completed"
	}
	created := cloneMap(r)
	created["status"] = "in_progress"
	created["output"] = []any{}
	sendMap(w, map[string]any{"type": "response.created", "response": created})
	if out, ok := r["output"].([]any); ok {
		for i, item := range out {
			sendMap(w, map[string]any{"type": "response.output_item.done", "output_index": i, "item": item})
		}
	}
	final := cloneMap(r)
	final["status"] = status
	sendMap(w, map[string]any{"type": "response." + status, "response": final})
}
func cloneMap(in map[string]any) map[string]any {
	o := make(map[string]any, len(in))
	for k, v := range in {
		o[k] = v
	}
	return o
}
func sendMap(w *bufio.Writer, v map[string]any) { b, _ := json.Marshal(v); _ = writeWSText(w, b) }
