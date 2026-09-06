package sidecar

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

// requestURLs each case against the handler and returns the raw response.
func do(t *testing.T, h http.Handler, method, path string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func writeRelayHeaders(t *testing.T, token, secret, path string, body []byte, nonce string) http.Header {
	t.Helper()
	expiresAt := time.Now().Add(10 * time.Second).UnixMilli()
	proof := managementauth.WriteRelayProof{Nonce: nonce, Principal: managementauth.PrincipalAdminToken, Method: http.MethodPut, Path: path, ExpiresAt: expiresAt}
	proof.Proof = managementauth.CreateWriteRelayProof(secret, proof, body)
	if proof.Proof == "" {
		t.Fatal("write relay proof was empty")
	}
	headers := make(http.Header)
	headers.Set(SidecarRequestHeader, token)
	headers.Set(managementauth.WriteRelayNonceHeader, proof.Nonce)
	headers.Set(managementauth.WriteRelayPrincipalHeader, string(proof.Principal))
	headers.Set(managementauth.WriteRelayExpiresAtHeader, fmt.Sprintf("%d", proof.ExpiresAt))
	headers.Set(managementauth.WriteRelayProofHeader, proof.Proof)
	headers.Set("Content-Type", "application/json")
	return headers
}

func TestConfigWriteRelayVerifiesProofAndRelaysOnlyTheAllowlist(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	const body = "{\"streamMode\":\"eager-relay\"}"
	var bridgeCalls int
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bridgeCalls++
		if r.Method != http.MethodPut || r.URL.Path != privateWriteBridgePath {
			t.Errorf("bridge request = %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get(SidecarBridgeHeader) != bridgeToken {
			t.Error("bridge token missing")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.Header.Get(managementauth.WriteRelayPrincipalHeader) != string(managementauth.PrincipalAdminToken) {
			t.Errorf("principal = %q", r.Header.Get(managementauth.WriteRelayPrincipalHeader))
		}
		if got, _ := io.ReadAll(r.Body); string(got) != body {
			t.Errorf("bridge body = %s, want %s", got, body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte("{\"error\":\"configuration is busy\"}"))
	}))
	defer bridge.Close()

	h := NewHandler(Config{ParentURL: bridge.URL, BridgeToken: bridgeToken, RequestToken: requestToken, WriteRelaySecret: bridgeToken})
	path := "/api/settings"
	req := httptest.NewRequest(http.MethodPut, path, bytes.NewBufferString(body))
	req.Header = writeRelayHeaders(t, requestToken, bridgeToken, path, []byte(body), fmt.Sprintf("%043d", 1))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	resp := rec.Result()
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusConflict || string(raw) != "{\"error\":\"configuration is busy\"}" {
		t.Fatalf("response = %d %s", resp.StatusCode, raw)
	}
	if got := resp.Header.Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1", got)
	}
	if bridgeCalls != 1 {
		t.Fatalf("bridge calls = %d, want 1", bridgeCalls)
	}

	replayed := httptest.NewRequest(http.MethodPut, path, bytes.NewBufferString(body))
	replayed.Header = req.Header.Clone()
	replayRec := httptest.NewRecorder()
	h.ServeHTTP(replayRec, replayed)
	if replayRec.Code != http.StatusUnauthorized {
		t.Fatalf("replay status = %d, want 401", replayRec.Code)
	}
	blocked := httptest.NewRequest(http.MethodPost, "/api/providers", bytes.NewBufferString(body))
	blocked.Header = writeRelayHeaders(t, requestToken, bridgeToken, "/api/providers", []byte(body), fmt.Sprintf("%043d", 2))
	blockedRec := httptest.NewRecorder()
	h.ServeHTTP(blockedRec, blocked)
	if blockedRec.Code != http.StatusNotFound {
		t.Fatalf("non-allowlisted write status = %d, want 404", blockedRec.Code)
	}
	if bridgeCalls != 1 {
		t.Fatalf("blocked write reached bridge (%d calls)", bridgeCalls)
	}
}

func TestConfigWriteRelayRejectsMissingTokenOrChangedBody(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	body := []byte("{\"enabled\":true}")
	h := NewHandler(Config{ParentURL: "http://127.0.0.1:1", BridgeToken: bridgeToken, RequestToken: requestToken, WriteRelaySecret: bridgeToken})
	path := "/api/shadow-call-settings"
	missing := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(body))
	missingRec := httptest.NewRecorder()
	h.ServeHTTP(missingRec, missing)
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("missing request token status = %d, want 404", missingRec.Code)
	}
	changed := httptest.NewRequest(http.MethodPut, path, bytes.NewBufferString("{\"enabled\":false}"))
	changed.Header = writeRelayHeaders(t, requestToken, bridgeToken, path, body, fmt.Sprintf("%043d", 1))
	changedRec := httptest.NewRecorder()
	h.ServeHTTP(changedRec, changed)
	if changedRec.Code != http.StatusUnauthorized {
		t.Fatalf("changed body status = %d, want 401", changedRec.Code)
	}
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

func TestProviderQuotasRelaysTheParentStateBridgeVerbatim(t *testing.T) {
	const requestToken = "parent-to-sidecar"
	const bridgeToken = "sidecar-to-parent"
	const want = `{"generatedAt":123,"reports":[{"provider":"test"}]}`
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/__ocx_go_sidecar/provider-quotas" {
			t.Errorf("bridge request = %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.RawQuery != "refresh=1" {
			t.Errorf("bridge query = %q, want refresh=1", r.URL.RawQuery)
		}
		if r.Header.Get("X-Ocx-Go-Sidecar-Bridge") != bridgeToken {
			t.Errorf("bridge capability was not forwarded")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(want))
	}))
	defer bridge.Close()

	h := NewHandler(Config{ParentURL: bridge.URL, BridgeToken: bridgeToken, RequestToken: requestToken})
	denied := do(t, h, http.MethodGet, "/api/provider-quotas")
	denied.Body.Close()
	if denied.StatusCode != http.StatusNotFound {
		t.Fatalf("unauthenticated quota request status = %d, want 404", denied.StatusCode)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/provider-quotas?refresh=1", nil)
	req.Header.Set("X-Ocx-Go-Sidecar-Request", requestToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	resp := rec.Result()
	defer resp.Body.Close()
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
	if string(raw) != want {
		t.Fatalf("body = %s, want %s", raw, want)
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
