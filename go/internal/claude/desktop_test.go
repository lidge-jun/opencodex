package claude

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDesktop3pConfigGenerationRoundTrip(t *testing.T) {
	routed := []Desktop3pRoutedModel{
		{Provider: "openrouter", ID: "google/gemini-3-pro", ContextWindow: OneMillion},
		{Provider: "anthropic", ID: "claude-opus-4-8", ContextWindow: 200_000},
	}
	cfg, err := GenerateDesktop3pConfig(10100, []string{"gpt-5.6"}, routed, "secret", Desktop3pStatic)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeDesktop3pConfig(wire)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.InferenceGatewayBaseURL != "http://127.0.0.1:10100" || decoded.ModelDiscoveryEnabled {
		t.Fatalf("decoded config = %#v", decoded)
	}
	if len(decoded.InferenceModels) != 3 || !decoded.InferenceModels[0].IsFamilyDefault || !decoded.InferenceModels[1].Supports1M {
		t.Fatalf("models = %#v", decoded.InferenceModels)
	}
	alias := Desktop3pAlias("openrouter", "google/gemini-3-pro")
	if route, ok := ResolveDesktop3pAlias(alias); !ok || route != "openrouter/google/gemini-3-pro" {
		t.Fatalf("alias %q resolved to %q, %v", alias, route, ok)
	}
	if route := ResolveInboundModel(alias, nil); route != "openrouter/google/gemini-3-pro" {
		t.Fatalf("inbound alias resolved to %q", route)
	}
	if route, ok := ResolveDesktop3pAlias("claude-opus-4-8"); ok || route != "" {
		t.Fatalf("native Anthropic model entered registry: %q, %v", route, ok)
	}
}

func TestDesktop3pModeArgsRejectConflictAndUnknown(t *testing.T) {
	if mode, err := ParseDesktop3pModeArgs(nil); err != nil || mode != Desktop3pStatic {
		t.Fatalf("default mode = %q, %v", mode, err)
	}
	if _, err := ParseDesktop3pModeArgs([]string{"--static", "--hybrid"}); err == nil {
		t.Fatal("conflicting modes were accepted")
	}
	if _, err := ParseDesktop3pModeArgs([]string{"--future"}); err == nil {
		t.Fatal("unknown mode was accepted")
	}
}

func TestPersistDesktop3pConfigReusesMetadataEntry(t *testing.T) {
	dir := t.TempDir()
	first, err := PersistDesktop3pConfig(dir, 10100, nil, nil, "ocx", Desktop3pStatic)
	if err != nil {
		t.Fatal(err)
	}
	second, err := PersistDesktop3pConfig(dir, 10101, nil, nil, "ocx", Desktop3pHybrid)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("config id changed: %q != %q", first, second)
	}
	data, err := os.ReadFile(filepath.Join(dir, "_meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), `"name": "opencodex"`) != 1 {
		t.Fatalf("metadata duplicated entry: %s", data)
	}
}

func TestClaudeAgentSyncRejectsPathTraversal(t *testing.T) {
	_, err := SyncClaudeAgentDefs([]ClaudeAgentDef{{File: "../ocx-owned.md", Name: "ocx-owned", Model: "p/m"}}, t.TempDir())
	if err == nil {
		t.Fatal("path traversal filename was accepted")
	}
}

func TestClaudeAgentDefinitionSyncPreservesUserFiles(t *testing.T) {
	configDir := t.TempDir()
	agentsDir := filepath.Join(configDir, "agents")
	if err := os.MkdirAll(agentsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	userFile := filepath.Join(agentsDir, "ocx-user.md")
	if err := os.WriteFile(userFile, []byte("user authored\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(agentsDir, "ocx-stale.md")
	if err := os.WriteFile(stale, []byte("<!-- generated-by: opencodex -->\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	routedAlias := Desktop3pAlias("openrouter", "moonshot/kimi-k2")
	defs := BuildClaudeAgentDefs(AgentConfig{
		Models:        []AgentModel{{Provider: "openrouter", ID: "moonshot/kimi-k2"}},
		DefaultModel:  "claude-ocx-openrouter--main",
		BlockedSkills: []string{"claude-api", "bad`<skill>"},
		AutoContext:   AutoContextMode{Enabled: true, CompactWindow: AutoCompactWindowDefault},
	}, map[string]int{routedAlias: OneMillion})
	written, err := SyncClaudeAgentDefs(defs, configDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 2 || written[0] != "ocx-moonshot-kimi-k2.md" || written[1] != "ocx-self.md" {
		t.Fatalf("written = %#v", written)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale generated file remains: %v", err)
	}
	if data, _ := os.ReadFile(userFile); string(data) != "user authored\n" {
		t.Fatalf("user file changed: %q", data)
	}
	generated, err := os.ReadFile(filepath.Join(agentsDir, written[0]))
	if err != nil {
		t.Fatal(err)
	}
	text := string(generated)
	if !strings.Contains(text, "generated-by: opencodex") || !strings.Contains(text, "[1m]") || strings.Contains(text, "bad`<skill>") {
		t.Fatalf("generated definition = %s", text)
	}
}

func TestGatewayCacheTTLAndRefresh(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/v1/models" || r.URL.Query().Get("ids") != "cli" {
			t.Fatalf("request URL = %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-ocx-p--m","display_name":"Model"},{"id":"gpt-hidden"}]}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	now := time.UnixMilli(1_700_000_000_000)
	path, refreshed, err := RefreshGatewayModelCache(context.Background(), server.Client(), server.URL, time.Hour, dir, now)
	if err != nil || !refreshed || requests != 1 {
		t.Fatalf("first refresh path=%q refreshed=%v requests=%d err=%v", path, refreshed, requests, err)
	}
	cache, err := ReadGatewayModelCache(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cache.Models) != 1 || cache.Models[0].ID != "claude-ocx-p--m" {
		t.Fatalf("cache = %#v", cache)
	}
	_, refreshed, err = RefreshGatewayModelCache(context.Background(), server.Client(), server.URL, time.Hour, dir, now.Add(30*time.Minute))
	if err != nil || refreshed || requests != 1 {
		t.Fatalf("fresh cache refreshed=%v requests=%d err=%v", refreshed, requests, err)
	}
	_, refreshed, err = RefreshGatewayModelCache(context.Background(), server.Client(), server.URL, time.Hour, dir, now.Add(2*time.Hour))
	if err != nil || !refreshed || requests != 2 {
		t.Fatalf("stale cache refreshed=%v requests=%d err=%v", refreshed, requests, err)
	}
}

func TestDebugRingBoundedRedactedAndDisableClears(t *testing.T) {
	ring := NewDebugRing(2, true)
	for i := 0; i < 3; i++ {
		ring.Capture("messages", map[string]any{
			"model":      "p/m",
			"stream":     true,
			"max_tokens": float64(100 + i),
			"system":     "private system prompt",
			"messages":   []any{map[string]any{"role": "user", "content": "private prompt"}},
			"metadata":   map[string]any{"user_id": "account@example.com", "token": "secret-token"},
			"api_key":    "sk-secret",
		}, "p/m", "context-1m-2025-08-07")
	}
	entries := ring.Entries()
	if len(entries) != 2 || entries[0].MaxTokens != 102 || entries[1].MaxTokens != 101 {
		t.Fatalf("entries = %#v", entries)
	}
	wire, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private system prompt", "private prompt", "account@example.com", "secret-token", "sk-secret"} {
		if strings.Contains(string(wire), secret) {
			t.Fatalf("debug ring leaked %q in %s", secret, wire)
		}
	}
	if !entries[0].HasMetadataUserID || !entries[0].HasSystem || len(entries[0].UserIDTag) != 8 || entries[0].UserIDTag != entries[1].UserIDTag {
		t.Fatalf("redacted equality fields = %#v", entries)
	}
	ring.SetEnabled(false)
	if got := ring.Entries(); len(got) != 0 {
		t.Fatalf("disabled ring retained entries: %#v", got)
	}
	ring.Capture("messages", map[string]any{"model": "ignored"}, "", "")
	if got := ring.Entries(); len(got) != 0 {
		t.Fatalf("disabled ring captured entries: %#v", got)
	}
}
