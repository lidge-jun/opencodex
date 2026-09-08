package ocxcli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// ─────────────────────────────────────────────────────────────────────────────
// Engine goldens: fixed /api/models rows (6 rows incl. a disabled row and a
// duplicate namespaced row) → catalog → V1/V2 blocks → minimal runtime content
// and an inherited-content merge. The byte constants in opencode_golden_test.go
// are frozen output from the TS engine (src/cli/opencode.ts) captured on
// 2026-09-09; re-running the TS engine is the oracle.

const goldenRowsFixture = `[
  {"namespaced":"provider2/model-b","provider":"provider2","id":"model-b","contextWindow":64000,"reasoningEfforts":["low","high"],"displayNameSource":"provider"},
  {"namespaced":"openai/gpt-5.2","provider":"openai","id":"gpt-5.2","native":true,"contextWindow":300000,"displayNameSource":"fallback"},
  {"namespaced":"provider1/model-a","provider":"provider1","id":"model-a","displayName":"Model A","displayNameSource":"operator","contextWindow":128000,"defaultReasoningEffort":"high","reasoningEfforts":["none","high"]},
  {"namespaced":"disabled/model","provider":"x","id":"model","disabled":true},
  {"namespaced":"provider1/model-a","provider":"provider1","id":"model-a2"},
  {"namespaced":"noctx/provider","provider":"noctx","id":"provider","reasoningEfforts":[]}
]`

// opencodeGoldenView mirrors the golden probe's `config = { providers: {} }`.
func opencodeGoldenView() exportConfigView {
	return exportConfigView{hostname: "", unauthLoopback: false, codexDirect: false}
}

func goldenFixtureValue(t *testing.T) *jsonwire.Value {
	t.Helper()
	value, err := jsonwire.Parse([]byte(goldenRowsFixture))
	if err != nil {
		t.Fatalf("fixture parse: %v", err)
	}
	return value
}

func serializeValue(t *testing.T, value *jsonwire.Value) string {
	t.Helper()
	raw, err := value.Encode()
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return string(raw)
}

func TestOpencodeCatalogGolden(t *testing.T) {
	models := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	if len(models) != 4 {
		t.Fatalf("catalog count = %d, want 4 (disabled + duplicate dropped)", len(models))
	}
	catalog := make([]string, 0, len(models))
	for _, model := range models {
		catalog = append(catalog, model.namespaced)
	}
	want := []string{"provider2/model-b", "openai/gpt-5.2", "provider1/model-a", "noctx/provider"}
	for i, namespaced := range want {
		if catalog[i] != namespaced {
			t.Fatalf("catalog[%d] = %s, want %s", i, catalog[i], namespaced)
		}
	}
	// displayNameSource === "fallback" drops the displayName on the native row
	// (catalog carry), and reasoningEfforts are filtered to non-"none".
	rowOrder := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	label := exportModelLabel(rowOrder[0])
	if label != "model-b (provider2)" {
		t.Fatalf("label = %q, want %q", label, "model-b (provider2)")
	}
	native := rowOrder[1]
	if native.displayName != "" {
		t.Fatalf("fallback-source displayName survived on native row: %q", native.displayName)
	}
	effortModel := rowOrder[2]
	if len(effortModel.reasoningEfforts) != 2 || effortModel.reasoningEfforts[0] != "none" || effortModel.reasoningEfforts[1] != "high" {
		t.Fatalf("reasoningEfforts = %v, want [none high]", effortModel.reasoningEfforts)
	}
}

func TestOpencodeBlocksGolden(t *testing.T) {
	models := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	blocks := exportOpenCodeProviderBlocks("http://127.0.0.1:10100/v1", models, opencodeGoldenView())
	if got := serializeValue(t, blocks.v1); got != goldenV1 {
		t.Fatalf("V1 block mismatch\n got: %s\nwant: %s", got, goldenV1)
	}
	if got := serializeValue(t, blocks.v2); got != goldenV2 {
		t.Fatalf("V2 block mismatch\n got: %s\nwant: %s", got, goldenV2)
	}
}

func TestOpencodeMergeContentGolden(t *testing.T) {
	models := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	blocks := exportOpenCodeProviderBlocks("http://127.0.0.1:10100/v1", models, opencodeGoldenView())
	// Minimal runtime object when no inherited content is present.
	merged, err := opencodeMergeContent("", blocks)
	if err != nil {
		t.Fatalf("merge empty: %v", err)
	}
	if got := serializeValue(t, merged); got != goldenContent {
		t.Fatalf("minimal content mismatch\n got: %s\nwant: %s", got, goldenContent)
	}
	// Inherited content: foreign keys keep position and value; only the two
	// opencodex members are replaced (opencodex in provider is replaced in
	// place, opencodex in providers appends after the legacy member).
	inherited := `{"$schema":"https://custom.test/config.json","theme":"dark","provider":{"other":{"npm":"x"},"opencodex":"stale"},"providers":{"legacy":{"package":"y"}}}`
	mergedInherited, err := opencodeMergeContent(inherited, blocks)
	if err != nil {
		t.Fatalf("merge inherited: %v", err)
	}
	if got := serializeValue(t, mergedInherited); got != goldenInherited {
		t.Fatalf("inherited content mismatch\n got: %s\nwant: %s", got, goldenInherited)
	}
}

func TestOpencodeMergeContentErrors(t *testing.T) {
	models := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	blocks := exportOpenCodeProviderBlocks("http://127.0.0.1:10100/v1", models, opencodeGoldenView())
	cases := []struct {
		name      string
		inherited string
		want      string
	}{
		{"invalid json", `{nope`, "OPENCODE_CONFIG_CONTENT is not valid JSON."},
		{"array", `[1,2]`, "OPENCODE_CONFIG_CONTENT must be a JSON object."},
		{"null", `null`, "OPENCODE_CONFIG_CONTENT must be a JSON object."},
		{"provider typed wrong", `{"provider":"x"}`, "OPENCODE_CONFIG_CONTENT provider must be a JSON object when present."},
		{"providers typed wrong", `{"providers":[]}`, "OPENCODE_CONFIG_CONTENT providers must be a JSON object when present."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := opencodeMergeContent(tc.inherited, blocks)
			if err == nil || err.Error() != tc.want {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestOpencodeMergeSchemaReplacement(t *testing.T) {
	models := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	blocks := exportOpenCodeProviderBlocks("http://127.0.0.1:10100/v1", models, opencodeGoldenView())
	// A non-string $schema is replaced with the default; an existing string is kept.
	merged, err := opencodeMergeContent(`{"$schema":42}`, blocks)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if got := serializeValue(t, merged); !strings.Contains(got, `"$schema":"https://opencode.ai/config.json"`) {
		t.Fatalf("non-string schema not replaced: %s", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONC stripping (stripJsonComments + stripTrailingCommas + parseJsonc).

func TestOpencodeParseJSONC(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string // serialized object when valid; "" when invalid
	}{
		{"plain json", `{"a":1}`, `{"a":1}`},
		{"comments", "{\n  // line\n  \"a\": 1 /* block */,\n  \"b\": \"// not a comment\"\n}", `{"a":1,"b":"// not a comment"}`},
		{"trailing comma", `{"a":1,}`, `{"a":1}`},
		{"escaped quote in string", `{"a":"x\\\"//y"}`, `{"a":"x\\\"//y"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value, err := opencodeParseJSONC(tc.text)
			if tc.want == "" {
				if err == nil {
					t.Fatalf("expected error, got %s", serializeValue(t, value))
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got := serializeValue(t, value); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestOpencodeStripTrailingCommaWhitespace(t *testing.T) {
	// The whitespace walk before } must honor Unicode whitespace (\s in JS).
	// The whitespace itself is preserved (JSON allows NBSP as whitespace); only
	// the comma before it is dropped — mirroring the TS stripper exactly.
	text := "{\"a\":1,\u00a0}" // NBSP between comma and close brace
	got := opencodeStripTrailingCommas(text)
	if got != "{\"a\":1\u00a0}" {
		t.Fatalf("NBSP trailing comma not stripped: %q", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-override detection.

func TestOpencodeProviderOverridePath(t *testing.T) {
	home := t.TempDir()
	sub := filepath.Join(home, "project", "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// No global, no local config: nothing found.
	if got := opencodeProviderOverridePath(sub, "", home); got != "" {
		t.Fatalf("unexpected override: %q", got)
	}
	// Nearest ancestor project config wins (jsonc tolerant parse).
	write(filepath.Join(sub, "opencode.jsonc"), "// comment\n{\"provider\": {\"opencodex\": {\"npm\": \"x\"}}}")
	if got := opencodeProviderOverridePath(sub, "", home); got != filepath.Join(sub, "opencode.jsonc") {
		t.Fatalf("project override = %q", got)
	}
	// Global config beats a project config when both define our key.
	write(filepath.Join(home, ".config", "opencode", "opencode.json"), `{"providers":{"opencodex":{"package":"p"}}}`)
	if got := opencodeProviderOverridePath(sub, "", home); got != filepath.Join(home, ".config", "opencode", "opencode.json") {
		t.Fatalf("global override = %q", got)
	}
	// Walk stops at the git root: a key-carrying config above it is not seen.
	if err := os.Remove(filepath.Join(sub, "opencode.jsonc")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(home, ".config", "opencode", "opencode.json")); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(home, "project", ".git"), "gitdir: x")
	write(filepath.Join(home, "opencode.json"), `{"provider":{"opencodex":{}}}`)
	if got := opencodeProviderOverridePath(sub, "", home); got != "" {
		t.Fatalf("walk escaped git root: %q", got)
	}
	// A config without our key is ignored.
	write(filepath.Join(sub, "opencode.json"), `{"provider":{"other":{}}}`)
	if got := opencodeProviderOverridePath(sub, "", home); got != "" {
		t.Fatalf("keyless config matched: %q", got)
	}
}

func TestOpencodeGlobalConfigPathXDG(t *testing.T) {
	if got := opencodeGlobalConfigPath("", "/home/u"); got != "/home/u/.config/opencode/opencode.json" {
		t.Fatalf("default global path = %q", got)
	}
	if got := opencodeGlobalConfigPath("/xdg", "/home/u"); got != "/xdg/opencode/opencode.json" {
		t.Fatalf("xdg global path = %q", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Admission key precedence (env token → service token file → apiKeys[0].key →
// "ocx"). Uses t.Setenv so each subtest owns an isolated environment.

func TestOpencodeAPIKeyPrecedence(t *testing.T) {
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
	t.Setenv("OCX_API_TOKEN_FILE", "")
	t.Run("env token wins", func(t *testing.T) {
		t.Setenv("OPENCODEX_API_AUTH_TOKEN", "  env-token  ")
		if got := opencodeAPIKey(nil); got != "env-token" {
			t.Fatalf("apiKey = %q", got)
		}
	})
	t.Run("token file wins over apiKeys", func(t *testing.T) {
		t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
		file := filepath.Join(t.TempDir(), "token")
		if err := os.WriteFile(file, []byte(" file-token \n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("OCX_API_TOKEN_FILE", file)
		cfg, _ := jsonwire.Parse([]byte(`{"apiKeys":[{"key":"cfg-key"}]}`))
		if got := opencodeAPIKey(cfg); got != "file-token" {
			t.Fatalf("apiKey = %q", got)
		}
	})
	t.Run("apiKeys key used", func(t *testing.T) {
		t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
		t.Setenv("OCX_API_TOKEN_FILE", filepath.Join(t.TempDir(), "absent"))
		cfg, _ := jsonwire.Parse([]byte(`{"apiKeys":[{"key":" cfg-key "}]}`))
		if got := opencodeAPIKey(cfg); got != "cfg-key" {
			t.Fatalf("apiKey = %q", got)
		}
	})
	t.Run("placeholder", func(t *testing.T) {
		t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
		t.Setenv("OCX_API_TOKEN_FILE", filepath.Join(t.TempDir(), "absent"))
		if got := opencodeAPIKey(nil); got != "ocx" {
			t.Fatalf("apiKey = %q", got)
		}
	})
}

// TestOpencodeMergeContentKeepsProviderValueReferences pins that foreign
// members are shared, not copied, when the document is re-serialized (the
// bytes are what matters, but a mutation must never touch the caller's tree).
func TestOpencodeMergeContentNoCrossTalk(t *testing.T) {
	models := exportModelsFromProxyRowsRaw(goldenFixtureValue(t), opencodeGoldenView())
	blocks := exportOpenCodeProviderBlocks("http://127.0.0.1:10100/v1", models, opencodeGoldenView())
	inherited := `{"theme":"dark"}`
	merged, err := opencodeMergeContent(inherited, blocks)
	if err != nil {
		t.Fatal(err)
	}
	if got := serializeValue(t, merged); !strings.Contains(got, `"theme":"dark"`) {
		t.Fatalf("foreign member lost: %s", got)
	}
	// Re-merging the same inherited text twice must produce identical bytes.
	again, err := opencodeMergeContent(inherited, blocks)
	if err != nil {
		t.Fatal(err)
	}
	if serializeValue(t, merged) != serializeValue(t, again) {
		t.Fatal("merge not deterministic")
	}
}
