package sidecar

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// relayFixtureConfigDir writes the canonical #27 fixture config into a temp
// dir: one key-mode openai-responses provider named "test" whose models list
// owns "test-model", defaultProvider "test", and an upstream loopback URL.
// Returns the dir and the resolved relay endpoint the upstream must see.
func relayFixtureConfigDir(t *testing.T, upstreamURL string, extra map[string]any) string {
	t.Helper()
	dir := t.TempDir()
	provider := map[string]any{
		"adapter":             "openai-responses",
		"baseUrl":             upstreamURL + "/v1",
		"allowPrivateNetwork": true,
		"disabled":            false,
		"models":              []any{"test-model"},
	}
	for key, value := range extra {
		if value == nil {
			delete(provider, key)
		} else {
			provider[key] = value
		}
	}
	config := map[string]any{
		"defaultProvider": "test",
		"providers": map[string]any{
			"test": provider,
		},
	}
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// relaySeamHandler builds the full sidecar handler for one fixture config dir,
// pointing the parent bridge at a port that is never listening. A direct relay
// answers 200 without it; any fall-through to the bridge answers 503 — which
// is how the tests distinguish the two paths.
func relaySeamHandler(t *testing.T, configDir string, relayOn bool) http.Handler {
	t.Helper()
	return NewHandler(Config{
		Service:          "opencodex",
		Version:          "2.42.0",
		ParentURL:        "http://127.0.0.1:1", // deliberately dead bridge
		BridgeToken:      "sidecar-to-parent",
		RequestToken:     "parent-to-sidecar",
		WriteRelaySecret: "sidecar-to-parent",
		ConfigDir:        configDir,
		HotPathRelay:     relayOn,
	})
}

func relayPost(t *testing.T, h http.Handler, body string) (*httptest.ResponseRecorder, error) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
	req.Header.Set(SidecarRequestHeader, "parent-to-sidecar")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, rec.Result().Body.Close()
}

// deadSparseUpstream returns a recording upstream that answers POST
// /v1/responses with a sparse non-streaming JSON body (missing annotations, id
// and status) so the client-visible bytes prove the repair ran. requestLog
// receives every request the relay actually made.
func deadSparseUpstream(t *testing.T, requestLog func(r *http.Request, body []byte)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("upstream read body: %v", err)
		}
		if requestLog != nil {
			requestLog(r, body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"resp_fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}`))
	}))
}

func TestDirectRelayReplacesTheBridgeForARelaySafeRequest(t *testing.T) {
	upstream := deadSparseUpstream(t, nil)
	defer upstream.Close()

	var sawMethod, sawPath, sawUA, sawAuth, sawCT string
	var sawBody []byte
	upstream.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawMethod = r.Method
		sawPath = r.URL.Path
		sawUA = r.UserAgent()
		sawAuth = r.Header.Get("Authorization")
		sawCT = r.Header.Get("Content-Type")
		var err error
		sawBody, err = io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("upstream read body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"resp_fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}`))
	})

	configDir := relayFixtureConfigDir(t, upstream.URL, nil)
	h := relaySeamHandler(t, configDir, true)
	const requestBody = `{"model":"test-model","input":"ping"}`
	rec, err := relayPost(t, h, requestBody)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (bridge is dead; a 503 would mean no direct relay)", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	// The client-visible body must be the REPAIRED bytes, not the sparse
	// upstream body: annotations, id and status are all backfilled.
	want := `{"id":"resp_fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi","annotations":[]}],"id":"msg_ocx_0","status":"completed"}]}`
	if got := rec.Body.String(); got != want {
		t.Fatalf("client body diverged\n got: %s\nwant: %s", got, want)
	}

	// The outbound upstream call mirrors the TS passthrough: same verb, same
	// responses path, the request body verbatim, JSON content type, no auth
	// header for a keyless provider, and Go's own user agent (the marker that
	// distinguishes direct relay from the Bun bridge in the differential).
	if sawMethod != http.MethodPost || sawPath != "/v1/responses" {
		t.Fatalf("upstream saw %s %s, want POST /v1/responses", sawMethod, sawPath)
	}
	if string(sawBody) != requestBody {
		t.Fatalf("upstream body diverged\n got: %s\nwant: %s", sawBody, requestBody)
	}
	if sawCT != "application/json" {
		t.Fatalf("upstream Content-Type = %q", sawCT)
	}
	if sawAuth != "" {
		t.Fatalf("upstream Authorization = %q for a keyless provider", sawAuth)
	}
	if !strings.HasPrefix(sawUA, "Go-http-client/") {
		t.Fatalf("upstream User-Agent = %q, want the Go http client's", sawUA)
	}
}

func TestDirectRelaySendsResolvedBearerWhenProviderHasAPIKey(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"resp_fixture","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}`))
	}))
	defer upstream.Close()

	t.Setenv("OCX_TEST_KEY", "secret-value")
	configDir := relayFixtureConfigDir(t, upstream.URL, map[string]any{"apiKey": "${OCX_TEST_KEY}"})
	h := relaySeamHandler(t, configDir, true)
	// Capture the upstream Authorization header.
	var auth string
	upstream.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"r","status":"completed","output":[]}`))
	})
	rec, err := relayPost(t, h, `{"model":"test-model","input":"ping"}`)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if auth != "Bearer secret-value" {
		t.Fatalf("Authorization = %q, want Bearer secret-value", auth)
	}
}

func TestDirectRelayPreservesRetryAfterAndNonJSON2xxVerbatum(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit_exceeded"}}`))
	}))
	defer upstream.Close()

	configDir := relayFixtureConfigDir(t, upstream.URL, nil)
	h := relaySeamHandler(t, configDir, true)
	rec, err := relayPost(t, h, `{"model":"test-model","input":"ping"}`)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q, want 7 (valid upstream header survives)", got)
	}
	// Non-2xx bodies are relayed verbatim, never repaired.
	if got, want := rec.Body.String(), `{"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit_exceeded"}}`; got != want {
		t.Fatalf("body diverged\n got: %s\nwant: %s", got, want)
	}
}

func TestDirectRelayDropsInvalidRetryAfterAndRepairsPlain2xx(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		// An ok non-streaming JSON body with a garbage Retry-After.
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "garbage")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"r","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}`))
	}))
	defer upstream.Close()

	configDir := relayFixtureConfigDir(t, upstream.URL, nil)
	h := relaySeamHandler(t, configDir, true)
	rec, err := relayPost(t, h, `{"model":"test-model","input":"ping"}`)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "" {
		t.Fatalf("Retry-After = %q, want dropped (invalid upstream value)", got)
	}
	if !strings.Contains(rec.Body.String(), `"annotations":[]`) || !strings.Contains(rec.Body.String(), `"id":"msg_ocx_0"`) {
		t.Fatalf("repair did not run on the 2xx body: %s", rec.Body.String())
	}
}

// TestDirectRelayStreamingFallsBackToBridge: the relay claims non-streaming
// requests only. A streaming request on the same config must take the bridge
// path — proven by the 503 from the dead bridge (a relay would have answered
// 200 from the fixture upstream).
func TestDirectRelayStreamingFallsBackToBridge(t *testing.T) {
	upstream := deadSparseUpstream(t, nil)
	defer upstream.Close()
	configDir := relayFixtureConfigDir(t, upstream.URL, nil)
	h := relaySeamHandler(t, configDir, true)
	rec, err := relayPost(t, h, `{"model":"test-model","input":"ping","stream":true}`)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (streaming request must not reach the relay)", rec.Code)
	}
}

// TestDirectRelayGateOffStaysOnTheBridge: with the relay env gate off the
// whole predicate short-circuits and every request takes the bridge.
func TestDirectRelayGateOffStaysOnTheBridge(t *testing.T) {
	configDir := relayFixtureConfigDir(t, "http://127.0.0.1:9", nil)
	h := relaySeamHandler(t, configDir, false)
	rec, err := relayPost(t, h, `{"model":"test-model","input":"ping"}`)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (gate off means bridge)", rec.Code)
	}
}

func TestRequestQualifiesForRelayRefusals(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	cases := []struct {
		name       string
		configEdit map[string]any
		body       string
		headers    map[string]string
		wantRefuse string
	}{
		{"happy path qualifies", nil, `{"model":"test-model","input":"ping"}`, nil, ""},
		{"unknown model routes to default provider", nil, `{"model":"other-model","input":"ping"}`, nil, ""},
		{"streaming refuses", nil, `{"model":"test-model","input":"ping","stream":true}`, nil, "streaming"},
		{"namespaced model refuses", nil, `{"model":"test/test-model","input":"ping"}`, nil, "namespaced"},
		{"empty model refuses", nil, `{"model":"","input":"ping"}`, nil, "model id is empty"},
		{"previous_response_id refuses", nil, `{"model":"test-model","input":"ping","previous_response_id":"x"}`, nil, "previous_response_id"},
		{"compaction marker refuses", nil, `{"model":"test-model","input":"ping","compaction_trigger":"x"}`, nil, "compaction"},
		{"namespaced tool refuses", nil, `{"model":"test-model","input":"ping","tools":[{"type":"function","name":"f","namespace":"mcp"}]}`, nil, "namespace"},
		{"non-function tool refuses", nil, `{"model":"test-model","input":"ping","tools":[{"type":"web_search"}]}`, nil, "not relay-safe"},
		{"encrypted input refuses", nil, `{"model":"test-model","input":[{"type":"message","encrypted_content":"blob"}]}`, nil, "encrypted_content"},
		{"codex parent header refuses", nil, `{"model":"test-model","input":"ping"}`, map[string]string{"x-codex-parent-thread-id": "t1"}, "x-codex-parent-thread-id"},
		{"grok surface refuses", nil, `{"model":"test-model","input":"ping"}`, map[string]string{"x-opencodex-grok": "1"}, "grok"},
		{"reserved openai row refuses", map[string]any{"name": "openai"}, `{"model":"test-model","input":"ping"}`, nil, "reserved native"},
		{"oauth auth mode refuses", map[string]any{"authMode": "oauth"}, `{"model":"test-model","input":"ping"}`, nil, "not key"},
		{"non-responses adapter refuses", map[string]any{"adapter": "anthropic"}, `{"model":"test-model","input":"ping"}`, nil, "not openai-responses"},
		{"keychain apiKey refuses", map[string]any{"apiKey": "keychain:prod"}, `{"model":"test-model","input":"ping"}`, nil, "keychain"},
		{"custom responsesPath refuses", map[string]any{"responsesPath": "/chat"}, `{"model":"test-model","input":"ping"}`, nil, "responsesPath"},
		{"default provider absent refuses", map[string]any{"defaultProvider": "gone"}, `{"model":"other-model","input":"ping"}`, nil, "no provider owns model"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			name := "test"
			extra := map[string]any{}
			if c.configEdit != nil {
				extra = c.configEdit
			}
			defaultProvider := "test"
			if _, renamed := extra["name"]; renamed {
				name = extra["name"].(string)
				delete(extra, "name")
			}
			if value, ok := extra["defaultProvider"]; ok {
				defaultProvider = value.(string)
				delete(extra, "defaultProvider")
			}
			config := map[string]any{
				"defaultProvider": defaultProvider,
				"providers": map[string]any{
					name: map[string]any{
						"adapter":             "openai-responses",
						"baseUrl":             upstream.URL + "/v1",
						"allowPrivateNetwork": true,
						"disabled":            false,
						"models":              []any{"test-model"},
					},
				},
			}
			for key, value := range extra {
				config["providers"].(map[string]any)[name].(map[string]any)[key] = value
			}
			raw, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "config.json"), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			headers := make(http.Header)
			for key, value := range c.headers {
				headers.Set(key, value)
			}
			plan, refusal := requestQualifiesForRelay(Config{HotPathRelay: true, ConfigDir: dir}, "application/json", headers, []byte(c.body))
			if c.wantRefuse == "" {
				if plan == nil {
					t.Fatalf("expected a plan, got refusal %q", refusal.reason)
				}
				return
			}
			if plan != nil {
				t.Fatalf("expected refusal containing %q, got a plan", c.wantRefuse)
			}
			if refusal == nil || !strings.Contains(refusal.reason, c.wantRefuse) {
				t.Fatalf("refusal = %v, want it to contain %q", refusal, c.wantRefuse)
			}
		})
	}
}

func TestOpenaiResponsesRelayURLNormalisesBase(t *testing.T) {
	cases := map[string]string{
		"http://host/v1":            "http://host/v1/responses",
		"http://host/v1/":           "http://host/v1/responses",
		"http://host/v1/responses":  "http://host/v1/responses",
		"http://host/v1/responses/": "http://host/v1/responses",
		"http://host":               "http://host/v1/responses",
		"http://host/":              "http://host/v1/responses",
		"http://host/base/v1":       "http://host/base/v1/responses",
	}
	for input, want := range cases {
		got, ok := openaiResponsesRelayURL(input)
		if !ok || got != want {
			t.Errorf("openaiResponsesRelayURL(%q) = %q,%v want %q,true", input, got, ok, want)
		}
	}
	for _, input := range []string{"not a url", "ftp://host/v1", "http://user:pw@host/v1", "http:///v1"} {
		if _, ok := openaiResponsesRelayURL(input); ok {
			t.Errorf("openaiResponsesRelayURL(%q) should refuse", input)
		}
	}
}

func TestRelayRetryAfterValidation(t *testing.T) {
	valid := []string{"7", "0", " 12 ", "Wed, 21 Oct 2015 07:28:00 GMT", "120"}
	for _, value := range valid {
		if !relayRetryAfterValid(value) {
			t.Errorf("relayRetryAfterValid(%q) = false, want true", value)
		}
	}
	invalid := []string{"", "garbage", "  ", "999999999999999999999999", strings.Repeat("a", 129)}
	for _, value := range invalid {
		if relayRetryAfterValid(value) {
			t.Errorf("relayRetryAfterValid(%q) = true, want false", value)
		}
	}
}

// TestDirectRelayBodyBound mirrors the TS bounded read: an oversized upstream
// JSON body must not leak a partial body to the client.
func TestDirectRelayBodyBound(t *testing.T) {
	huge := `{"id":"r","output":[` + strings.Repeat(`{"type":"message","content":[]},`, (maxRelayUpstreamBodyBytes/32)+16) + `]}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(huge))
	}))
	defer upstream.Close()
	configDir := relayFixtureConfigDir(t, upstream.URL, nil)
	h := relaySeamHandler(t, configDir, true)
	rec, err := relayPost(t, h, `{"model":"test-model","input":"ping"}`)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for an oversized upstream body", rec.Code)
	}
	if got := rec.Body.String(); !bytes.Contains([]byte(got), []byte("exceeded the safe body limit")) {
		t.Fatalf("body = %s", got)
	}
}
