package ocxcli

// The loopback-only MMX text bridge (port of startMmxTextBridge in
// src/cli/minimax.ts). MMX hard-codes /anthropic/v1/messages below its
// configured base URL while OpenCodex already exposes the canonical Anthropic
// data plane at /v1/messages; the bridge adapts the client-specific path
// inside the checked launcher instead of widening the proxy's authentication
// surface. The listener binds 127.0.0.1 on an ephemeral port, and every hop
// to the OpenCodex proxy goes through a transport that ignores HTTP(S)_PROXY
// so the request cannot leave the machine.

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
)

type mmxTextBridge struct {
	listener net.Listener
	server   *http.Server
	portNum  int
	proxyURL string
	client   *http.Client
}

func (b *mmxTextBridge) port() int { return b.portNum }

func (b *mmxTextBridge) stop() {
	// Close aborts in-flight hops like Bun's server.stop(true); removal of the
	// listener happens synchronously so the caller can delete the temp dir.
	_ = b.server.Close()
	_ = b.listener.Close()
}

func startMmxTextBridge(hostname string, port int, deps Deps) (*mmxTextBridge, error) {
	proxyHost := probeHost(hostname)
	upstream := "http://" + proxyHost + ":" + strconv.Itoa(port)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	bridge := &mmxTextBridge{
		listener: listener,
		portNum:  listener.Addr().(*net.TCPAddr).Port,
		proxyURL: upstream,
		client: &http.Client{
			// Never honor inherited HTTP(S)_PROXY for the upstream hop; the
			// destination is loopback and a parent proxy could reroute it.
			Transport: &http.Transport{Proxy: nil},
		},
	}
	server := &http.Server{Handler: http.HandlerFunc(bridge.serve)}
	bridge.server = server
	go func() {
		_ = server.Serve(listener)
	}()
	return bridge, nil
}

func (b *mmxTextBridge) serve(w http.ResponseWriter, req *http.Request) {
	canonicalPath := ""
	switch req.URL.Path {
	case "/anthropic/v1/messages":
		canonicalPath = "/v1/messages"
	case "/anthropic/v1/messages/count_tokens":
		canonicalPath = "/v1/messages/count_tokens"
	}
	if req.Method != http.MethodPost || canonicalPath == "" {
		writeBridgeError(w, 404, "not_found_error", "unsupported MMX bridge route")
		return
	}
	target := b.proxyURL + canonicalPath
	if req.URL.RawQuery != "" {
		target += "?" + req.URL.RawQuery
	}
	outgoing, err := http.NewRequest(http.MethodPost, target, req.Body)
	if err != nil {
		writeBridgeError(w, 502, "api_error", "OpenCodex proxy unavailable")
		return
	}
	for key, values := range req.Header {
		lower := strings.ToLower(key)
		if lower == "authorization" || lower == "x-opencodex-api-key" || lower == "host" || lower == "content-length" {
			continue
		}
		for _, value := range values {
			outgoing.Header.Add(key, value)
		}
	}
	// The bridge is loopback-only and OpenCodex does not require a real key
	// there. Pin the public placeholder even if a future MMX release loads a
	// credential from somewhere outside the isolated config directory.
	outgoing.Header.Set("x-api-key", loopbackKey)
	response, doErr := b.client.Do(outgoing)
	if doErr != nil {
		writeBridgeError(w, 502, "api_error", "OpenCodex proxy unavailable")
		return
	}
	defer response.Body.Close()
	for key, values := range response.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	// Anthropic messages stream SSE chunks through the proxy. net/http buffers
	// writes up to its internal chunk size, so without an explicit flush the
	// first tokens would sit in the buffer while the TS bridge streams them
	// through untouched; flush after the headers and after every read.
	flusher, canFlush := w.(http.Flusher)
	if canFlush {
		flusher.Flush()
	}
	if response.Body != nil {
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := response.Body.Read(buffer)
			if n > 0 {
				if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
					return
				}
				if canFlush {
					flusher.Flush()
				}
			}
			if readErr != nil {
				return
			}
		}
	}
}

func writeBridgeError(w http.ResponseWriter, status int, errorType string, message string) {
	body := map[string]any{
		"type":  "error",
		"error": map[string]string{"type": errorType, "message": message},
	}
	raw, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
