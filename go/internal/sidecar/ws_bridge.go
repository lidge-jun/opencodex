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
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const (
	ResponsesWSBridgePath       = "/v1/responses/ws-bridge"
	ResponsesWSParentBridgePath = "/__ocx_go_sidecar/responses-ws"
	maxWSFrameBytes             = 50 * 1024 * 1024
	maxSynthesizedOutputItems   = 10000
)

type wsBridgeRequest struct {
	// Frame can contain the parent-owned, allowlisted header snapshot required
	// to recreate a native WebSocket turn. The sidecar treats it as opaque and
	// forwards it only to the token-gated parent bridge; it never logs it or
	// sends it to an upstream provider.
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
	stream := newWSSSEBlockReader(bufio.NewReader(resp.Body), maxWSFrameBytes)
	first := true
	for {
		block, e := stream.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			if e == errWSSSEBlockTooLarge {
				protocolWSError(w, "Upstream SSE frame exceeds WebSocket frame limit")
			} else {
				protocolWSError(w, "Unable to read upstream SSE stream")
			}
			return
		}
		if first {
			first = false
			if !strings.Contains(ct, "text/event-stream") && !looksSSE(block) {
				protocolWSError(w, "Unexpected successful non-SSE upstream response ("+ct+")")
				return
			}
		}
		payload, hasData := sseDataPayloadBytes(block)
		if !hasData || len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		var v map[string]any
		if json.Unmarshal(payload, &v) != nil {
			protocolWSError(w, "Invalid JSON payload in upstream SSE frame")
			return
		}
		if err := writeWSText(w, payload); err != nil {
			return
		}
		// A WebSocket client must see every complete Responses event promptly,
		// even while the upstream HTTP response remains open.
		if err := w.Flush(); err != nil {
			return
		}
		typ, _ := v["type"].(string)
		if typ == "response.completed" || typ == "response.failed" || typ == "response.incomplete" {
			// Match the parent bridge: a Responses terminal ends this relay even
			// when an upstream keeps its HTTP connection open afterwards.
			return
		}
	}
	if first && !strings.Contains(ct, "text/event-stream") {
		protocolWSError(w, "Unexpected successful non-SSE upstream response ("+ct+")")
		return
	}
	protocolWSError(w, "Upstream stream ended before response terminal event")
}
func looksSSE(b []byte) bool {
	s := strings.TrimSpace(string(b))
	return strings.HasPrefix(s, "data:") || strings.HasPrefix(s, "event:")
}

var errWSSSEBlockTooLarge = errors.New("upstream SSE frame exceeds WebSocket frame limit")

// wsSSEBlockReader incrementally frames one upstream SSE response. Its limit
// applies to each SSE event, which becomes one WebSocket text frame; it never
// limits the aggregate response length.
type wsSSEBlockReader struct {
	r     *bufio.Reader
	buf   []byte
	limit int
}

func newWSSSEBlockReader(r *bufio.Reader, limit int) *wsSSEBlockReader {
	return &wsSSEBlockReader{r: r, limit: limit}
}

func (s *wsSSEBlockReader) Next() ([]byte, error) {
	for {
		at, delimiterLen, _ := sseDelimiter(s.buf)
		if at >= 0 {
			block := append([]byte(nil), s.buf[:at]...)
			s.buf = append(s.buf[:0], s.buf[at+delimiterLen:]...)
			return block, nil
		}
		if len(s.buf) > s.limit {
			return nil, errWSSSEBlockTooLarge
		}
		chunk, err := s.r.ReadSlice('\n')
		if len(chunk) > 0 {
			s.buf = append(s.buf, chunk...)
			if len(s.buf) > s.limit {
				return nil, errWSSSEBlockTooLarge
			}
		}
		if err == nil || err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF && len(s.buf) > 0 {
			block := append([]byte(nil), s.buf...)
			s.buf = nil
			return block, nil
		}
		return nil, err
	}
}
func sendJSONEvents(w *bufio.Writer, r map[string]any) {
	if out, ok := r["output"].([]any); ok && len(out) > maxSynthesizedOutputItems {
		protocolWSError(w, "Responses JSON output contains "+strconv.Itoa(len(out))+" items; maximum is "+strconv.Itoa(maxSynthesizedOutputItems))
		return
	}
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
