package sidecar

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// responsesStreamFixture is a deterministic Responses SSE stream the bridge
// (the TS oracle in production) is expected to relay byte-for-byte. The
// harness compares ordered frames, so the seam must not re-frame, reorder or
// drop anything; the tests below pin that with raw byte identity.
const responsesStreamFixture = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"fixture-1\",\"status\":\"in_progress\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture-1\",\"status\":\"completed\"}}\n\n"

func dataPlaneSeamHandler(t *testing.T, requestToken, bridgeToken, parentURL string) http.Handler {
	t.Helper()
	return NewHandler(Config{
		Service:          "opencodex",
		Version:          "2.42.0",
		ParentURL:        parentURL,
		BridgeToken:      bridgeToken,
		RequestToken:     requestToken,
		WriteRelaySecret: bridgeToken,
	})
}

func dataPlaneHeaders(requestToken, bridgeToken string, body []byte) http.Header {
	headers := make(http.Header)
	headers.Set(SidecarRequestHeader, requestToken)
	headers.Set("Content-Type", "application/json")
	headers.Set(DataPlaneNonceHeader, "nonce-abcdefghijklmnopqrstuvwxyz0123456789-aa")
	headers.Set(DataPlaneExpiresAtHeader, "1800000000000")
	headers.Set(DataPlaneAdmissionHeader, `{"kind":"environment","source":"x-api-key"}`)
	headers.Set(DataPlaneProofHeader, "proof-0123456789abcdefghijklmnopqrstuvwxyzABCDEF")
	return headers
}

func TestDataPlaneSeamRelaysStreamByteForByte(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	const body = `{"model":"fixture","input":"ping","stream":true}`
	var gotBridgeMethod, gotBridgePath, gotBridgeToken string
	var gotClaimNonce, gotClaimAdmission, gotContentType string
	var gotBody []byte

	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBridgeMethod = r.Method
		gotBridgePath = r.URL.Path
		gotBridgeToken = r.Header.Get(SidecarBridgeHeader)
		gotClaimNonce = r.Header.Get(DataPlaneNonceHeader)
		gotClaimAdmission = r.Header.Get(DataPlaneAdmissionHeader)
		gotContentType = r.Header.Get("Content-Type")
		var readErr error
		gotBody, readErr = io.ReadAll(r.Body)
		if readErr != nil {
			t.Errorf("bridge read body: %v", readErr)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		// Write the fixture in small chunks on purpose: a buffering seam could
		// preserve bytes yet reorder delivery. The oracle compares frames, so
		// the seam must preserve chunked write order too.
		for _, chunk := range strings.SplitAfter(responsesStreamFixture, "\n") {
			if _, err := w.Write([]byte(chunk)); err != nil {
				t.Errorf("bridge write chunk: %v", err)
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}))
	defer bridge.Close()

	h := dataPlaneSeamHandler(t, requestToken, bridgeToken, bridge.URL)
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewBufferString(body))
	req.Header = dataPlaneHeaders(requestToken, bridgeToken, []byte(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	resp := rec.Result()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != responsesStreamFixture {
		t.Fatalf("relayed stream diverged:\n got %q\nwant %q", raw, responsesStreamFixture)
	}

	if gotBridgeMethod != http.MethodPost || gotBridgePath != DataPlaneBridgePath {
		t.Fatalf("bridge request = %s %s, want POST %s", gotBridgeMethod, gotBridgePath, DataPlaneBridgePath)
	}
	if gotBridgeToken != bridgeToken {
		t.Fatalf("bridge token = %q", gotBridgeToken)
	}
	if gotClaimNonce == "" || gotClaimAdmission == "" {
		t.Fatal("claim headers were not relayed")
	}
	if gotContentType != "application/json" {
		t.Fatalf("content-type = %q", gotContentType)
	}
	if string(gotBody) != body {
		t.Fatalf("bridge body = %q, want %q", gotBody, body)
	}
}

func TestDataPlaneSeamRelaysBridgeStatusAndRetryAfter(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("data: {\"type\":\"error\"}\n\n"))
	}))
	defer bridge.Close()

	h := dataPlaneSeamHandler(t, requestToken, bridgeToken, bridge.URL)
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewBufferString(`{}`))
	req.Header = dataPlaneHeaders(requestToken, bridgeToken, []byte(`{}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	resp := rec.Result()
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", resp.StatusCode)
	}
	if got := resp.Header.Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q", got)
	}
	if string(raw) != "data: {\"type\":\"error\"}\n\n" {
		t.Fatalf("body = %q", raw)
	}
}

func TestDataPlaneSeamRejectsUnauthenticatedOrWrongRouteRequests(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	var bridgeCalls int
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bridgeCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer bridge.Close()

	h := dataPlaneSeamHandler(t, requestToken, bridgeToken, bridge.URL)

	// Missing and wrong request token both answer 404 and never reach the bridge.
	for _, headers := range []http.Header{nil, dataPlaneHeaders("wrong", bridgeToken, []byte(`{}`))} {
		req := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewBufferString(`{}`))
		req.Header = headers
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("missing/wrong token status = %d, want 404", rec.Code)
		}
	}
	// A GET on the data-plane path is not a declared seam surface.
	req := httptest.NewRequest(http.MethodGet, "/v1/responses", nil)
	req.Header = dataPlaneHeaders(requestToken, bridgeToken, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /v1/responses status = %d, want 404", rec.Code)
	}
	if bridgeCalls != 0 {
		t.Fatalf("unauthenticated request reached bridge (%d calls)", bridgeCalls)
	}
}

func TestDataPlaneSeamRejectsNonLoopbackOrMissingBridgeConfig(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"

	// A public (non-loopback) parent URL must be refused before any request.
	for _, parentURL := range []string{"https://example.test/bridge", "http://127.0.0.1:1"} {
		h := NewHandler(Config{
			ParentURL:    parentURL,
			BridgeToken:  bridgeToken,
			RequestToken: requestToken,
		})
		req := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewBufferString(`{}`))
		req.Header = dataPlaneHeaders(requestToken, bridgeToken, []byte(`{}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("parent %q status = %d, want 503", parentURL, rec.Code)
		}
	}

	// No bridge token configured: the seam must refuse rather than guess.
	h := NewHandler(Config{
		ParentURL:    "http://127.0.0.1:1",
		RequestToken: requestToken,
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewBufferString(`{}`))
	req.Header = dataPlaneHeaders(requestToken, "", []byte(`{}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing bridge token status = %d, want 503", rec.Code)
	}
}

func TestDataPlaneSeamOversizedBodyIsRefused(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	var bridgeCalls int
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bridgeCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer bridge.Close()

	h := dataPlaneSeamHandler(t, requestToken, bridgeToken, bridge.URL)
	big := strings.Repeat("x", maxDataPlaneBodyBytes+1)
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(big))
	req.Header = dataPlaneHeaders(requestToken, bridgeToken, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	// The bridge never sees an oversized body; the seam answers 413 itself.
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d, want 413", rec.Code)
	}
	if bridgeCalls != 0 {
		t.Fatalf("oversized request reached bridge (%d calls)", bridgeCalls)
	}
}
