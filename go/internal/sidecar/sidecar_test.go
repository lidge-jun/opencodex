package sidecar

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// writeConfigFile writes a config.json fixture into dir and returns its path.
func writeConfigFile(t *testing.T, dir, content string) string {
	t.Helper()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestShadowCallSettingsShapeAndOrder(t *testing.T) {
	dir := t.TempDir()
	writeConfigFile(t, dir, `{"shadowCallIntercept": {"enabled": true, "model": "gpt-5.5", "sourceModels": ["gpt-5.4-mini"]}}`)
	h := NewHandler(Config{ConfigDir: dir})

	resp := do(t, h, http.MethodGet, "/api/shadow-call-settings")
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
	// Byte contract with the TS handler: the raw body must be exactly this
	// string (key order enabled, model, sourceModels; no trailing newline).
	want := `{"enabled":true,"model":"gpt-5.5","sourceModels":["gpt-5.4-mini"]}`
	if string(raw) != want {
		t.Fatalf("body = %s, want %s", raw, want)
	}
}

func TestShadowCallSettingsDefaultsWithoutConfig(t *testing.T) {
	// No config.json at all: the body must match the TS handler reading a
	// default config (enabled false, model "", default source list).
	h := NewHandler(Config{ConfigDir: t.TempDir()})
	resp := do(t, h, http.MethodGet, "/api/shadow-call-settings")
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"enabled":false,"model":"","sourceModels":["gpt-5.6-luna"]}`
	if string(raw) != want {
		t.Fatalf("body = %s, want %s", raw, want)
	}
}

func TestShadowCallSettingsCoercions(t *testing.T) {
	dir := t.TempDir()
	// Mirrors the TS projection: enabled only when strictly true, model echoed
	// verbatim when a string, empty entries dropped from sourceModels.
	writeConfigFile(t, dir, `{"shadowCallIntercept": {"enabled": "yes", "model": "  gpt-5.5  ", "sourceModels": [" ", "gpt-6-terra", ""]}}`)
	h := NewHandler(Config{ConfigDir: dir})
	resp := do(t, h, http.MethodGet, "/api/shadow-call-settings")
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"enabled":false,"model":"  gpt-5.5  ","sourceModels":["gpt-6-terra"]}`
	if string(raw) != want {
		t.Fatalf("body = %s, want %s", raw, want)
	}
}

func TestShadowCallSettingsSurfaceIsNarrow(t *testing.T) {
	h := NewHandler(Config{ConfigDir: t.TempDir()})
	cases := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/api/shadow-call-settings", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/config", http.StatusNotFound},
		{http.MethodGet, "/api/settings", http.StatusNotFound},
		{http.MethodGet, "/api/shadow-call-settings/", http.StatusNotFound},
		{http.MethodGet, "/api/shadow-call-settings?x=1", http.StatusOK},
	}
	for _, tc := range cases {
		resp := do(t, h, tc.method, tc.path)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("%s %s status = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.want)
		}
	}
}

func TestCustomModelsEchoVerbatim(t *testing.T) {
	dir := t.TempDir()
	// Pretty-printed, unknown per-entry keys, key order NOT matching any schema:
	// the echo must follow the file (JSON.stringify of the parsed value), not a
	// Go struct.
	writeConfigFile(t, dir, `{
  "port": 18080,
  "customModels": [
    { "zetaField": 1, "provider": "test", "modelId": "custom-a", "displayName": "Custom A", "contextWindow": 99999 },
    { "provider": "anthropic", "modelId": "custom-b" }
  ]
}`)
	h := NewHandler(Config{ConfigDir: dir})
	resp := do(t, h, http.MethodGet, "/api/custom-models")
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
	want := `[{"zetaField":1,"provider":"test","modelId":"custom-a","displayName":"Custom A","contextWindow":99999},{"provider":"anthropic","modelId":"custom-b"}]`
	if string(raw) != want {
		t.Fatalf("body = %s\nwant  %s", raw, want)
	}
}

func TestCustomModelsDefaultsWithoutConfig(t *testing.T) {
	// No customModels key and no config file at all both coalesce to [] (the TS
	// handler's `config.customModels ?? []`).
	for _, tc := range []struct {
		name    string
		content string
	}{
		{"missing key", `{"port": 18080}`},
		{"null value", `{"customModels": null}`},
		{"no file", ""},
	} {
		dir := t.TempDir()
		if tc.content != "" {
			writeConfigFile(t, dir, tc.content)
		}
		h := NewHandler(Config{ConfigDir: dir})
		resp := do(t, h, http.MethodGet, "/api/custom-models")
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != "[]" {
			t.Errorf("%s: body = %s, want []", tc.name, raw)
		}
	}
}

func TestCustomModelsSurfaceIsNarrow(t *testing.T) {
	h := NewHandler(Config{ConfigDir: t.TempDir()})
	cases := []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodPost, "/api/custom-models", http.StatusMethodNotAllowed},
		{http.MethodPut, "/api/custom-models", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/custom-models/", http.StatusNotFound},
		{http.MethodGet, "/api/custom-models?x=1", http.StatusOK},
	}
	for _, tc := range cases {
		resp := do(t, h, tc.method, tc.path)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("%s %s status = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.want)
		}
	}
}
