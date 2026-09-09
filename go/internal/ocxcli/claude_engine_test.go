package ocxcli

// Golden tests for the claude engine pure functions. `goldenClaude` in
// claude_golden_test.go is frozen output from the TS engine probe
// (/tmp/oc_claude_probe.ts, captured 2026-09-09); the Go port must reproduce
// every scenario byte-for-byte. Fixtures here mirror the probe exactly.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func claudeGoldenScenarios(t *testing.T) map[string]map[string]json.RawMessage {
	t.Helper()
	var doc []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(goldenClaude), &doc); err != nil {
		t.Fatalf("golden parse: %v", err)
	}
	out := map[string]map[string]json.RawMessage{}
	for _, entry := range doc {
		var name string
		if err := json.Unmarshal(entry["name"], &name); err != nil {
			t.Fatalf("golden scenario name: %v", err)
		}
		out[name] = entry
	}
	return out
}

func claudeGoldenStringMap(t *testing.T, raw json.RawMessage) map[string]string {
	t.Helper()
	var out map[string]string
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("golden string map: %v", err)
	}
	return out
}

func claudeGoldenStrings(t *testing.T, raw json.RawMessage) []string {
	t.Helper()
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("golden strings: %v", err)
	}
	return out
}

// claudeGoldenEngineDoc decodes a scenario's `result` envelope.
func claudeGoldenResult(t *testing.T, scenario map[string]json.RawMessage, key string) json.RawMessage {
	t.Helper()
	var result map[string]json.RawMessage
	if err := json.Unmarshal(scenario["result"], &result); err != nil {
		t.Fatalf("result envelope %s: %v", key, err)
	}
	raw, ok := result[key]
	if !ok {
		t.Fatalf("result has no key %s", key)
	}
	return raw
}

func claudeBoolPtr(value bool) *bool              { return &value }
func claudeInt64Ptr(value int64) *int64           { return &value }
func claudeFloat64Ptr(value float64) *float64     { return &value }
func claudeStrPtr(value string) *string           { return &value }

// probe config shape: apiKeys + optional overrides/claudeCode.
type claudeProbeConfig struct {
	apiKeys        []string
	claudeCode     *claudeCodeView
	subagentModels []string
}

func claudeProbeCfg(extraKeys ...string) claudeProbeConfig {
	keys := []string{"adm-one"}
	keys = append(keys, extraKeys...)
	return claudeProbeConfig{apiKeys: keys}
}

func claudeAbsentAuthSeam() claudeAuthDetectDeps {
	return claudeAuthDetectDeps{
		readClaudeJSON:        func() (map[string]any, bool, error) { return nil, false, nil },
		credentialsFileExists: func() (bool, error) { return false, nil },
		keychainProbe:         func() claudeAuthPresence { return claudeAuthAbsent },
	}
}

func claudeOAuthAuthSeam() claudeAuthDetectDeps {
	return claudeAuthDetectDeps{
		readClaudeJSON: func() (map[string]any, bool, error) {
			return map[string]any{"oauthAccount": map[string]any{"emailAddress": "user@example.com"}}, true, nil
		},
		credentialsFileExists: func() (bool, error) { return false, nil },
		keychainProbe:         func() claudeAuthPresence { return claudeAuthAbsent },
	}
}

// claudeRunScenario drives claudeBuildEnv with probe-style inputs and returns
// the relevant-filtered env plus warnings, mirroring runScn in the probe.
func claudeRunScenario(cfg claudeProbeConfig, route claudeLaunchRoute, base map[string]string, windows map[string]int64, seam claudeAuthDetectDeps) (map[string]string, []string) {
	input := claudeEngineInput{
		apiKeys:        cfg.apiKeys,
		claudeCode:     cfg.claudeCode,
		route:          route,
		base:           base,
		contextWindows: windows,
		deps: claudeEngineDeps{
			authDetect: &seam,
		},
	}
	launch := claudeBuildEnv(input)
	if launch.Warned == nil {
		launch.Warned = []string{}
	}
	filtered := map[string]string{}
	for key, value := range launch.Env {
		keep := strings.HasPrefix(key, "ANTHROPIC_") || strings.HasPrefix(key, "CLAUDE_CODE_") ||
			strings.HasPrefix(key, "OCX_") || key == "DISABLE_COMPACT" || key == "IS_SANDBOX"
		if keep {
			filtered[key] = value
		}
	}
	return filtered, launch.Warned
}

func TestClaudeEngineEnvGoldens(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	const port = 17432

	type row struct {
		name    string
		cfg     claudeProbeConfig
		route   claudeLaunchRoute
		base    map[string]string
		windows map[string]int64
		seam    claudeAuthDetectDeps
	}
	rows := []row{
		{
			name: "local-proxy-auto", cfg: claudeProbeCfg(), route: localClaudeRoute(port),
			base: map[string]string{}, seam: claudeAbsentAuthSeam(),
		},
		{
			name: "local-subscription-auto", cfg: claudeProbeCfg(), route: localClaudeRoute(port),
			base: map[string]string{}, seam: claudeOAuthAuthSeam(),
		},
		{
			name: "local-manual-proxy", cfg: claudeProbeConfig{apiKeys: []string{"adm-one"}, claudeCode: &claudeCodeView{AuthMode: "proxy"}},
			route: localClaudeRoute(port), base: map[string]string{}, seam: claudeOAuthAuthSeam(),
		},
		{
			name: "local-manual-subscription", cfg: claudeProbeConfig{apiKeys: []string{"adm-one"}, claudeCode: &claudeCodeView{AuthMode: "subscription"}},
			route: localClaudeRoute(port), base: map[string]string{}, seam: claudeAbsentAuthSeam(),
		},
		{
			name: "local-exported-user-key", cfg: claudeProbeCfg(), route: localClaudeRoute(port),
			base: map[string]string{"ANTHROPIC_API_KEY": "sk-ant-user-secret"}, seam: claudeAbsentAuthSeam(),
		},
		{
			name: "local-stale-marker", cfg: claudeProbeCfg(), route: localClaudeRoute(port),
			base: map[string]string{"ANTHROPIC_AUTH_TOKEN": "opencodex-proxy"}, seam: claudeAbsentAuthSeam(),
		},
		{
			name: "local-stale-base-url", cfg: claudeProbeCfg("adm-two"), route: localClaudeRoute(port),
			base: map[string]string{
				"ANTHROPIC_BASE_URL":    "http://127.0.0.1:9999",
				"ANTHROPIC_AUTH_TOKEN":  "adm-two",
			}, seam: claudeAbsentAuthSeam(),
		},
		{
			name: "connected-target", cfg: claudeProbeCfg(), route: connectedClaudeRoute("http://hub.example:8456", "conn-tok"),
			base: map[string]string{}, seam: claudeAbsentAuthSeam(),
		},
		{
			name: "connected-target-subscription-home", cfg: claudeProbeCfg(), route: connectedClaudeRoute("http://hub.example:8456", "conn-tok"),
			base: map[string]string{}, seam: claudeOAuthAuthSeam(),
		},
		{
			name: "max-context-and-effort", cfg: claudeProbeConfig{
				apiKeys: []string{"adm-one"},
				claudeCode: &claudeCodeView{
					MaxContextTokens:   claudeFloat64Ptr(120000),
					AlwaysEnableEffort: true,
				},
			},
			route: localClaudeRoute(port), base: map[string]string{}, seam: claudeAbsentAuthSeam(),
		},
	}

	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			golden := scenarios[r.name]
			wantEnv := claudeGoldenStringMap(t, claudeGoldenResult(t, golden, "env"))
			wantLogs := claudeGoldenStrings(t, claudeGoldenResult(t, golden, "logs"))
			gotEnv, gotLogs := claudeRunScenario(r.cfg, r.route, r.base, r.windows, r.seam)
			if !reflect.DeepEqual(gotEnv, wantEnv) {
				t.Errorf("env mismatch:\n got: %v\nwant: %v", gotEnv, wantEnv)
			}
			if !reflect.DeepEqual(gotLogs, wantLogs) {
				t.Errorf("logs mismatch:\n got: %v\nwant: %v", gotLogs, wantLogs)
			}
		})
	}
}

func TestClaudeEngineModelEnvGolden(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	golden := scenarios["model-env-1m"]
	wantEnv := claudeGoldenStringMap(t, claudeGoldenResult(t, golden, "env"))
	wantLogs := claudeGoldenStrings(t, claudeGoldenResult(t, golden, "logs"))

	windows := map[string]int64{
		"claude-ocx2-provider--anthropic~sclaude-opus-4-8": 1_500_000,
		"claude-ocx-native--gpt-5.2":                        372_000,
		"gpt-5.2":                                           372_000,
		"claude-opus-4-8-a1b":                               200_000,
	}
	slice := &claudeCodeView{
		Model: "claude-ocx2-provider--anthropic~sclaude-opus-4-8",
		TierModels: claudeTierModels{
			Opus:   claudeStrPtr("claude-ocx2-provider--anthropic~sclaude-opus-4-8"),
			Sonnet: claudeStrPtr("gpt-5.2"),
			Haiku:  claudeStrPtr("gpt-5.4-mini"),
			Fable:  claudeStrPtr("gpt-5.6-terra"),
		},
		SmallFastModel: "gpt-5.4-mini",
	}
	cfg := claudeProbeConfig{apiKeys: []string{"adm-one"}, claudeCode: slice}
	gotEnv, gotLogs := claudeRunScenario(cfg, localClaudeRoute(17432), map[string]string{}, windows, claudeAbsentAuthSeam())
	if !reflect.DeepEqual(gotEnv, wantEnv) {
		t.Errorf("env mismatch:\n got: %v\nwant: %v", gotEnv, wantEnv)
	}
	if !reflect.DeepEqual(gotLogs, wantLogs) {
		t.Errorf("logs mismatch: got %v want %v", gotLogs, wantLogs)
	}
}

func TestClaudeAutoContextGolden(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	golden := scenarios["auto-context"]
	var want map[string]map[string]any
	if err := json.Unmarshal(golden["result"], &want); err != nil {
		t.Fatalf("golden auto-context: %v", err)
	}
	envFor := func(tokens string) string { return tokens }
	type autoCtxGolden struct {
		Enabled       bool    `json:"enabled"`
		CompactWindow float64 `json:"compactWindow"`
	}
	wantTyped := map[string]autoCtxGolden{}
	for key, raw := range want {
		var entry autoCtxGolden
		if err := json.Unmarshal(mustRaw(raw), &entry); err != nil {
			t.Fatalf("%s decode: %v", key, err)
		}
		wantTyped[key] = entry
	}
	cases := []struct {
		key   string
		slice claudeAutoContextSlice
		env   string
	}{
		{key: "defaultOn", slice: claudeAutoContextSlice{}},
		{key: "explicitOff", slice: claudeAutoContextSlice{AutoContext: claudeBoolPtr(false)}},
		{key: "legacyPairInert", slice: claudeAutoContextSlice{MaxContextTokens: claudeFloat64Ptr(120000)}},
		{key: "envOverrideValid", slice: claudeAutoContextSlice{}, env: "600000"},
		{key: "envOverrideInvalid", slice: claudeAutoContextSlice{}, env: "50000"},
		{key: "configOutOfRange", slice: claudeAutoContextSlice{AutoCompactWindow: claudeInt64Ptr(50000)}},
		{key: "configInRange", slice: claudeAutoContextSlice{AutoCompactWindow: claudeInt64Ptr(700000)}},
	}
	for _, c := range cases {
		got := claudeResolveAutoContext(c.slice, envFor(c.env))
		wantCase := wantTyped[c.key]
		if got.Enabled != wantCase.Enabled || float64(got.CompactWindow) != wantCase.CompactWindow {
			t.Errorf("%s mismatch: got %+v want %+v", c.key, got, wantCase)
		}
	}
}

func TestClaudeOneMillionMarkersGolden(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	golden := scenarios["one-million-markers"]
	var want map[string]any
	if err := json.Unmarshal(golden["result"], &want); err != nil {
		t.Fatalf("golden markers: %v", err)
	}
	windows := map[string]int64{"m-1m": 1_500_000, "m-400k": 400_000, "m-150k": 150_000, "m-829k": 829_800}
	on := claudeResolveAutoContext(claudeAutoContextSlice{}, "")
	off := claudeAutoContextOff
	selectorFor := func(key string) string {
		switch key {
		case "has1m":
			return claudeWithOneMillionMarker("m-1m", windows, on)
		case "floorOver":
			return claudeWithOneMillionMarker("m-400k", windows, on)
		case "floorUnder":
			return claudeWithOneMillionMarker("m-150k", windows, on)
		case "exactDefault":
			return claudeWithOneMillionMarker("m-829k", windows, on)
		case "off":
			return claudeWithOneMillionMarker("m-400k", windows, off)
		case "alreadyMarked":
			return claudeWithOneMillionMarker("m-400k[1m]", windows, on)
		case "unknown":
			return claudeWithOneMillionMarker("nope", windows, on)
		}
		return ""
	}
	for key, expected := range want {
		var wantStr string
		if expected != nil {
			if err := json.Unmarshal(mustRaw(expected), &wantStr); err != nil {
				t.Fatalf("%s decode: %v", key, err)
			}
		}
		got := selectorFor(key)
		if key == "unknown" {
			if got != "nope" {
				t.Errorf("unknown: got %q want %q", got, wantStr)
			}
			continue
		}
		if got != wantStr {
			t.Errorf("%s: got %q want %q", key, got, wantStr)
		}
	}
}

func TestClaudeAliasTableGolden(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	golden := scenarios["alias-table"]
	var want map[string]any
	if err := json.Unmarshal(golden["result"], &want); err != nil {
		t.Fatalf("golden alias table: %v", err)
	}
	type aliasFn func() (string, bool)
	eval := func(fn aliasFn) string {
		value, _ := fn()
		return value
	}
	cases := []struct {
		key string
		fn  aliasFn
	}{
		{key: "routeSimple", fn: func() (string, bool) { return claudeAliasForRoute("provider2", "model-b") }},
		{key: "routeEscaped", fn: func() (string, bool) { return claudeAliasForRoute("openrouter", "anthropic/claude-opus-4-8") }},
		{key: "routeTilde", fn: func() (string, bool) { return claudeAliasForRoute("p", "a~b/c") }},
		{key: "routeRejected", fn: func() (string, bool) { return claudeAliasForRoute("native", "x") }},
		{key: "nativeSimple", fn: func() (string, bool) { return claudeAliasForNative("gpt-5.2") }},
		{key: "nativeSlashed", fn: func() (string, bool) { return claudeAliasForNative("a/b") }},
		{key: "nativeDashed", fn: func() (string, bool) { return claudeAliasForNative("a--b") }},
		{key: "resolveV1", fn: func() (string, bool) { return claudeResolveAlias("claude-ocx-provider2--model-b") }},
		{key: "resolveV2", fn: func() (string, bool) { return claudeResolveAlias("claude-ocx2-openrouter--anthropic~sclaude-opus-4-8") }},
		{key: "resolveNative", fn: func() (string, bool) { return claudeResolveAlias("claude-ocx-native--gpt-5.2") }},
		{key: "resolveForeign", fn: func() (string, bool) { return claudeResolveAlias("claude-opus-4-8") }},
		{key: "codeAliasAnthropicPassthrough", fn: func() (string, bool) { return claudeCodeAlias("anthropic", "claude-opus-4-8"), true }},
		{key: "codeAliasRoute", fn: func() (string, bool) { return claudeCodeAlias("provider2", "model-b"), true }},
		{key: "codeNative", fn: func() (string, bool) { return claudeCodeNativeAlias("gpt-5.2"), true }},
		{key: "desktop3pAnthropic", fn: func() (string, bool) { return claudeDesktop3pAlias("anthropic", "claude-opus-4-8"), true }},
		{key: "desktop3pRoute", fn: func() (string, bool) { return claudeDesktop3pAlias("provider2", "model-b"), true }},
		{key: "desktop3pNative", fn: func() (string, bool) { return claudeDesktop3pAlias("native", "gpt-5.2"), true }},
	}
	for _, c := range cases {
		var wantStr string
		if want[c.key] != nil {
			if err := json.Unmarshal(mustRaw(want[c.key]), &wantStr); err != nil {
				t.Fatalf("%s decode: %v", c.key, err)
			}
			got := eval(c.fn)
			if got != wantStr {
				t.Errorf("%s: got %q want %q", c.key, got, wantStr)
			}
		} else {
			got, ok := c.fn()
			if ok || got != "" {
				t.Errorf("%s: expected null, got %q ok=%v", c.key, got, ok)
			}
		}
	}
}

func TestClaudeConnectedCatalogDecodeGolden(t *testing.T) {
	scenarios := claudeGoldenScenarios(t)
	golden := scenarios["connected-catalog-decode"]
	var want map[string]float64
	if err := json.Unmarshal(golden["result"], &want); err != nil {
		t.Fatalf("golden catalog: %v", err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	fixture := `{
    "models": [
      { "slug": "anthropic/claude-opus-4-8", "context_window": 200000 },
      { "slug": "gpt-5.2", "context_window": 922000 },
      { "slug": "openrouter/anthropic/claude-sonnet-4-8", "context_window": 1200000 }
    ]
  }`
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	got := claudeReadConnectedContextWindows(path)
	gotF := map[string]float64{}
	for key, value := range got {
		gotF[key] = float64(value)
	}
	if !reflect.DeepEqual(gotF, want) {
		t.Errorf("catalog mismatch:\n got: %v\nwant: %v", gotF, want)
	}
}

// mustRaw re-encodes a decoded any back to JSON for typed unmarshal.
func mustRaw(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

var _ = strconv.Itoa
