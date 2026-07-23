package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type RelayOptions struct {
	Heartbeat time.Duration
	QueueSize int
}

type relayChunk struct {
	data []byte
	err  error
}

// RelaySSE eagerly reads upstream into a bounded queue and forwards it with idle heartbeats.
func RelaySSE(ctx context.Context, w http.ResponseWriter, upstream io.ReadCloser, options RelayOptions) error {
	defer upstream.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if options.Heartbeat <= 0 {
		options.Heartbeat = 15 * time.Second
	}
	if options.QueueSize <= 0 {
		options.QueueSize = 16
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	queue := make(chan relayChunk, options.QueueSize)
	go func() {
		defer close(queue)
		buffer := make([]byte, 32<<10)
		for {
			n, err := upstream.Read(buffer)
			if n > 0 {
				chunk := append([]byte(nil), buffer[:n]...)
				select {
				case queue <- relayChunk{data: chunk}:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					select {
					case queue <- relayChunk{err: err}:
					case <-ctx.Done():
					}
				}
				return
			}
		}
	}()
	ticker := time.NewTicker(options.Heartbeat)
	defer ticker.Stop()
	terminalSeen := false
	inspectTail := ""
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if _, err := io.WriteString(w, ": opencodex keepalive\n\n"); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
		case chunk, ok := <-queue:
			if !ok {
				return nil
			}
			if chunk.err != nil {
				if !terminalSeen {
					_ = WriteFailureTail(w, http.StatusBadGateway, chunk.err.Error())
				}
				if flusher != nil {
					flusher.Flush()
				}
				return chunk.err
			}
			inspectTail += string(chunk.data)
			if len(inspectTail) > 4096 {
				inspectTail = inspectTail[len(inspectTail)-4096:]
			}
			terminalSeen = hasResponsesTerminal(inspectTail)
			if _, err := w.Write(chunk.data); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func hasResponsesTerminal(value string) bool {
	for _, status := range []string{"completed", "failed", "incomplete"} {
		if strings.Contains(value, `"type":"response.`+status+`"`) || strings.Contains(value, `"type": "response.`+status+`"`) {
			return true
		}
	}
	return false
}

// WriteFailureTail writes a valid Responses terminal followed by [DONE].
func WriteFailureTail(w io.Writer, status int, message string) error {
	payload := map[string]any{"type": "response.failed", "response": map[string]any{"status": "failed", "error": map[string]any{"type": "server_error", "code": status, "message": message}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: response.failed\ndata: %s\n\ndata: [DONE]\n\n", encoded)
	return err
}
