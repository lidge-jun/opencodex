package sidecar

// Data-plane hot-path seam (ticket #24, devlog 034). The sidecar owns the
// public POST /v1/responses surface exactly like it owns the Go-owned
// management read/write routes; until a provider relay lands (#27/#29) its
// stream source is the private parent bridge, which runs the real in-process
// handleResponses pipeline. The seam's job is transport fidelity: status,
// headers and the body must cross the process boundary byte-for-byte and in
// stream order, because the streaming differential oracle compares the
// client-visible SSE frame sequence and fails on a dropped, reordered or
// duplicated frame.

import (
	"bytes"
	"io"
	"net/http"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const (
	// DataPlaneBridgePath is the private parent endpoint the seam asks to run
	// the in-process responses pipeline for one admitted request.
	DataPlaneBridgePath = "/__ocx_go_sidecar/responses"

	// The front door resolves data-plane admission before the seam gate and
	// mints a short-lived HMAC claim over the admission, method, path, expiry
	// and body digest; the sidecar never sees the client credential and only
	// relays these headers verbatim to the bridge, which verifies them.
	DataPlaneNonceHeader     = "X-Ocx-Go-Dataplane-Nonce"
	DataPlaneExpiresAtHeader = "X-Ocx-Go-Dataplane-Expires-At"
	DataPlaneAdmissionHeader = "X-Ocx-Go-Dataplane-Admission"
	DataPlaneProofHeader     = "X-Ocx-Go-Dataplane-Proof"

	// Matches src/server/request-decompress.ts MAX_DECOMPRESSED_BODY_BYTES:
	// the same body the in-process handler would have accepted must reach the
	// bridge. The seam streams rather than buffers, so the bound only caps the
	// read, not the memory.
	maxDataPlaneBodyBytes = 256 * 1024 * 1024
)

// mountDataPlaneSeam registers the hot-path seam route on the sidecar mux.
// The pattern is deliberately NOT method-qualified: an unqualified route lets
// the handler answer 404 for a non-POST request (the same allowlist shape as
// the write-relay routes) instead of letting ServeMux synthesise a 405 that
// would probe the seam's existence.
func mountDataPlaneSeam(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc("/v1/responses", func(w http.ResponseWriter, r *http.Request) {
		dataPlaneSeam(w, r, cfg)
	})
}

// dataPlaneSeam relays one admitted POST /v1/responses request to the parent
// bridge and streams the response back untouched. It answers 404 to anything
// that does not carry the parent request token: the sidecar must never invent
// a public data-plane listener of its own, and while the seam is mounted the
// in-process front door remains the only way a request reaches it.
func dataPlaneSeam(w http.ResponseWriter, r *http.Request, cfg Config) {
	if cfg.RequestToken == "" || !managementauth.EqualSecret(r.Header.Get(SidecarRequestHeader), cfg.RequestToken) {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/v1/responses" {
		http.NotFound(w, r)
		return
	}

	parent, ok := privateParentBridgeURL(cfg.ParentURL, DataPlaneBridgePath)
	if !ok || cfg.BridgeToken == "" {
		http.Error(w, "responses bridge unavailable", http.StatusServiceUnavailable)
		return
	}

	// The bridge verifies the body-bound claim, so the seam must relay the
	// body unchanged. Read it with the same ceiling the in-process handler
	// enforces (MAX_DECOMPRESSED_BODY_BYTES) and refuse oversized bodies
	// here, before any bridge hop.
	body, readErr := io.ReadAll(io.LimitReader(r.Body, maxDataPlaneBodyBytes+1))
	if readErr != nil {
		http.Error(w, "responses bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	if len(body) > maxDataPlaneBodyBytes {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	// The seam first asks whether this request can be served by the direct
	// provider relay (ticket #27): a relay-safe non-streaming request for a
	// key-mode openai-responses provider is answered upstream without the
	// parent bridge, everything else falls through to the in-process pipeline.
	// Refusals are silent here — they mean "bridge", never an error.
	if plan, _ := requestQualifiesForRelay(cfg, r.Header.Get("Content-Type"), r.Header, body); plan != nil {
		doDirectRelay(w, r, cfg, plan, body)
		return
	}

	bridgeReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, parent.String(), bytes.NewReader(body))
	if err != nil {
		http.Error(w, "responses bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	bridgeReq.Header.Set(SidecarBridgeHeader, cfg.BridgeToken)
	for _, name := range []string{
		DataPlaneNonceHeader,
		DataPlaneExpiresAtHeader,
		DataPlaneAdmissionHeader,
		DataPlaneProofHeader,
	} {
		if value := r.Header.Get(name); value != "" {
			bridgeReq.Header.Set(name, value)
		}
	}
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		bridgeReq.Header.Set("Content-Type", contentType)
	}

	bridgeResp, err := dataPlaneBridgeClient().Do(bridgeReq)
	if err != nil {
		http.Error(w, "responses bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	defer bridgeResp.Body.Close()

	if contentType := bridgeResp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	if retryAfter := bridgeResp.Header.Get("Retry-After"); retryAfter != "" {
		w.Header().Set("Retry-After", retryAfter)
	}
	w.WriteHeader(bridgeResp.StatusCode)
	if err := streamCopyWithFlush(w, bridgeResp.Body); err != nil {
		// The client went away mid-stream (or the bridge did): nothing useful
		// can be written now, and a partial body is the transport's normal
		// failure mode for an already-started stream.
		return
	}
}

// dataPlaneBridgeClient reaches the parent bridge without any total-request
// timeout: a response stream can legitimately run for minutes. Cancellation
// flows through the request context, and the bridge credential must never be
// sent through a system proxy (the parent is a literal IPv4 loopback
// listener), mirroring privateBridgeClient but without the 30s cap.
func dataPlaneBridgeClient() *http.Client {
	transport := bridgeTransport()
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// streamCopyWithFlush copies src to w, flushing after every write so SSE
// frames reach the front door as they arrive rather than in one trailing
// buffer. A flush per chunk is the transport-fidelity cost the seam exists to
// pay; frame order is preserved by construction (single sequential copy).
func streamCopyWithFlush(w http.ResponseWriter, src io.Reader) error {
	flusher, canFlush := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}
