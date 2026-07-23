package server

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocketBridge accepts text frames, executes them as /v1/responses JSON requests, and returns response text frames.
func WebSocketBridge(target http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
			http.Error(w, "websocket upgrade required", http.StatusUpgradeRequired)
			return
		}
		key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
		if key == "" {
			http.Error(w, "missing websocket key", http.StatusBadRequest)
			return
		}
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "websocket unsupported", http.StatusNotImplemented)
			return
		}
		conn, rw, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		digest := sha1.Sum([]byte(key + websocketGUID))
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(digest[:]))
		_ = rw.Flush()
		for {
			opcode, payload, err := readWSFrame(rw.Reader)
			if err != nil {
				return
			}
			switch opcode {
			case 0x8:
				_ = writeWSFrame(rw.Writer, 0x8, nil)
				_ = rw.Flush()
				return
			case 0x9:
				_ = writeWSFrame(rw.Writer, 0xA, payload)
				_ = rw.Flush()
				continue
			case 0x1:
				request := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(payload))
				request.Header.Set("Content-Type", "application/json")
				for _, name := range []string{"Authorization", "X-Codex-Turn-Metadata", "X-OpenAI-Subagent"} {
					request.Header.Set(name, r.Header.Get(name))
				}
				response := httptest.NewRecorder()
				target.ServeHTTP(response, request)
				if err := writeWSFrame(rw.Writer, 0x1, response.Body.Bytes()); err != nil {
					return
				}
				if err := rw.Flush(); err != nil {
					return
				}
			}
		}
	})
}

func readWSFrame(reader *bufio.Reader) (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return 0, nil, err
	}
	opcode, masked, length := header[0]&0x0f, header[1]&0x80 != 0, uint64(header[1]&0x7f)
	if length == 126 {
		var n uint16
		if err := binary.Read(reader, binary.BigEndian, &n); err != nil {
			return 0, nil, err
		}
		length = uint64(n)
	}
	if length == 127 {
		if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
			return 0, nil, err
		}
	}
	if length > 16<<20 {
		return 0, nil, fmt.Errorf("websocket frame exceeds limit")
	}
	if !masked {
		return 0, nil, fmt.Errorf("client websocket frame is not masked")
	}
	mask := make([]byte, 4)
	if _, err := io.ReadFull(reader, mask); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return opcode, payload, nil
}

func writeWSFrame(writer io.Writer, opcode byte, payload []byte) error {
	header := []byte{0x80 | opcode}
	switch {
	case len(payload) < 126:
		header = append(header, byte(len(payload)))
	case len(payload) <= 65535:
		header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
	default:
		header = append(header, 127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(len(payload)))
		header = append(header, b[:]...)
	}
	if _, err := writer.Write(header); err != nil {
		return err
	}
	_, err := writer.Write(payload)
	return err
}
