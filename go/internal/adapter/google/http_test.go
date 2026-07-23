package google

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDoWithRetryRepairsInvalidSchemaWithoutChargingTransientAttempt(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := attempts.Add(1)
		body, _ := io.ReadAll(r.Body)
		if attempt == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"tools.0.custom.input_schema is invalid JSON schema"}}`)
			return
		}
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		request := payload["request"].(map[string]any)
		declaration := request["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)[0].(map[string]any)
		parameters := declaration["parameters"].(map[string]any)
		if parameters["type"] != "object" {
			t.Errorf("repair body = %#v", parameters)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	body := []byte(`{"request":{"tools":[{"functionDeclarations":[{"name":"bad","parameters":{"type":"array"}}]}]}}`)
	req, _ := http.NewRequest(http.MethodPost, server.URL, bytes.NewReader(body))
	response, err := DoWithRetry(context.Background(), server.Client(), req, "Antigravity", RetryOptions{BaseDelay: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || attempts.Load() != 2 {
		t.Fatalf("status=%d attempts=%d", response.StatusCode, attempts.Load())
	}
}

func TestDoWithRetryRetriesTransientAndStopsOnHardQuota(t *testing.T) {
	var transientAttempts atomic.Int32
	transient := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if transientAttempts.Add(1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer transient.Close()
	req, _ := http.NewRequest(http.MethodPost, transient.URL, strings.NewReader(`{}`))
	response, err := DoWithRetry(context.Background(), transient.Client(), req, "Vertex AI", RetryOptions{BaseDelay: time.Nanosecond, MaxDelay: time.Microsecond})
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if transientAttempts.Load() != 3 {
		t.Fatalf("transient attempts = %d", transientAttempts.Load())
	}

	var quotaAttempts atomic.Int32
	quota := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		quotaAttempts.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"status":"RESOURCE_EXHAUSTED","message":"QuotaFailure: quota exceeded for billing"}}`)
	}))
	defer quota.Close()
	quotaReq, _ := http.NewRequest(http.MethodPost, quota.URL, strings.NewReader(`{}`))
	quotaResponse, err := DoWithRetry(context.Background(), quota.Client(), quotaReq, "Vertex AI", RetryOptions{BaseDelay: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	defer quotaResponse.Body.Close()
	payload, _ := io.ReadAll(quotaResponse.Body)
	if quotaAttempts.Load() != 1 || !strings.Contains(string(payload), "quota exhausted") {
		t.Fatalf("quota attempts=%d payload=%s", quotaAttempts.Load(), payload)
	}
}

func TestDoWithRetryHonorsCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req, _ := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(`{}`))
	if _, err := DoWithRetry(ctx, server.Client(), req, "Vertex AI", RetryOptions{}); err == nil {
		t.Fatal("expected cancellation")
	}
}
