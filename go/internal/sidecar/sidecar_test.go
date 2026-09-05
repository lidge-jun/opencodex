package sidecar

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"
	"time"
)

// requestURLs each case against the handler and returns the raw response.
func do(t *testing.T, h http.Handler, method, path string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func TestHealthShape(t *testing.T) {
	startedAt := time.Now().Add(-123 * time.Second)
	h := NewHandler(Config{Service: "opencodex", Version: "2.42.0", StartedAt: startedAt})

	resp := do(t, h, http.MethodGet, "/api/system/health")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 {
		t.Fatal("empty body")
	}

	// Key order is part of the byte contract with the TypeScript handler, so
	// verify textual order directly against the raw body: each key must appear
	// followed by its colon, and after the last key no earlier key may recur.
	wantKeys := []string{"status", "service", "version", "uptime", "pid"}
	probe := raw
	for _, key := range wantKeys {
		marker := []byte(`"` + key + `":`)
		idx := bytes.Index(probe, marker)
		if idx < 0 {
			t.Fatalf("body missing key %q in order (raw %s)", key, raw)
		}
		probe = probe[idx+len(marker):]
	}
	for _, key := range wantKeys {
		if bytes.Contains(probe, []byte(`"`+key+`":`)) {
			t.Fatalf("body repeats key %q after pid (raw %s)", key, raw)
		}
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("body is not a JSON object: %v", err)
	}
	if string(payload["status"]) != `"ok"` {
		t.Fatalf("status = %s, want \"ok\"", payload["status"])
	}
	if string(payload["service"]) != `"opencodex"` {
		t.Fatalf("service = %s, want \"opencodex\"", payload["service"])
	}
	if string(payload["version"]) != `"2.42.0"` {
		t.Fatalf("version = %s, want \"2.42.0\"", payload["version"])
	}
	uptimeRaw := string(payload["uptime"])
	if !regexp.MustCompile(`^\d+(\.\d+)?([eE][+-]?\d+)?$`).MatchString(uptimeRaw) {
		t.Fatalf("uptime = %q is not a JSON number", uptimeRaw)
	}
	if got := string(payload["pid"]); got == "" || got == "null" {
		t.Fatalf("pid missing from body (raw %s)", raw)
	}
}

func TestHealthReportsOwnPidAndRoughlyCorrectUptime(t *testing.T) {
	startedAt := time.Now().Add(-5 * time.Second)
	h := NewHandler(Config{Service: "opencodex", Version: "9.9.9", StartedAt: startedAt})
	resp := do(t, h, http.MethodGet, "/api/system/health")
	defer resp.Body.Close()

	var payload struct {
		Status  string  `json:"status"`
		Version string  `json:"version"`
		Uptime  float64 `json:"uptime"`
		Pid     int     `json:"pid"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Pid != os.Getpid() {
		t.Fatalf("pid = %d, want own pid %d", payload.Pid, os.Getpid())
	}
	// Uptime is anchored to StartedAt; allow the encode/decode round trip and
	// a little scheduling slop, but it must be near the configured anchor
	// rather than the process start time (which would be a much larger number
	// under a long-lived test binary).
	if payload.Uptime < 4 || payload.Uptime > 20 {
		t.Fatalf("uptime = %v, want ~5s (anchored to StartedAt)", payload.Uptime)
	}
	if payload.Version != "9.9.9" {
		t.Fatalf("version = %q, want the configured value", payload.Version)
	}
}

func TestHealthDefaults(t *testing.T) {
	// Absent Service/Version must degrade to the TS-handler fallbacks rather
	// than empty strings or a panic.
	h := NewHandler(Config{})
	resp := do(t, h, http.MethodGet, "/api/system/health")
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"status":"ok"`, `"service":"opencodex"`, `"version":"0.0.0"`} {
		if !bytes.Contains(raw, []byte(want)) {
			t.Fatalf("body %s missing %s", raw, want)
		}
	}
}

func TestHealthRouteSurfaceIsNarrow(t *testing.T) {
	h := NewHandler(Config{Service: "opencodex", Version: "1.0.0"})

	cases := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/api/system/health", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/system/memory", http.StatusNotFound},
		{http.MethodGet, "/api/system", http.StatusNotFound},
		{http.MethodGet, "/healthz", http.StatusNotFound},
		{http.MethodGet, "/api/system/health/", http.StatusNotFound},
		{http.MethodGet, "/api/system/health?x=1", http.StatusOK},
	}
	for _, tc := range cases {
		resp := do(t, h, tc.method, tc.path)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("%s %s status = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.want)
		}
	}
}

func TestReadyLineConstant(t *testing.T) {
	if ReadyLinePrefix != "ocx-sidecar-ready" {
		t.Fatalf("ReadyLinePrefix = %q changed; the TS supervisor parses this exact token", ReadyLinePrefix)
	}
}
