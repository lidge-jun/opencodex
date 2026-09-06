package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFixture(t *testing.T, dir, content string) string {
	t.Helper()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadMissingFileIsEmpty(t *testing.T) {
	dir := t.TempDir()
	cfg, err := LoadFromDir(dir)
	if err != nil {
		t.Fatalf("LoadFromDir on an empty dir returned an error: %v", err)
	}
	if cfg.ShadowCallIntercept != nil {
		t.Fatalf("expected no shadowCallIntercept for a missing file, got %+v", cfg.ShadowCallIntercept)
	}
}

func TestListenTargetUsesValidatedConfigOrDefault(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, "{\"port\": 18080, \"hostname\": \"127.0.0.2\"}")
	cfg, err := LoadFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if port, host := cfg.ListenTarget(); port != 18080 || host != "127.0.0.2" {
		t.Fatalf("ListenTarget = %d, %q", port, host)
	}
	writeFixture(t, dir, "{\"port\": 0}")
	cfg, err = LoadFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if port, host := cfg.ListenTarget(); port != 10100 || host != "" {
		t.Fatalf("default ListenTarget = %d, %q", port, host)
	}
}

func TestLoadMalformedJSONDefaultsWithoutMovingTheFile(t *testing.T) {
	dir := t.TempDir()
	path := writeFixture(t, dir, "{not json")
	cfg, err := LoadFromDir(dir)
	if err == nil {
		t.Fatal("expected a decode error for malformed JSON")
	}
	if cfg.ShadowCallIntercept != nil {
		t.Fatalf("expected no shadowCallIntercept after a decode failure, got %+v", cfg.ShadowCallIntercept)
	}
	// The TS side backs the file up on an invalid parse; the Go side must never
	// move or rewrite user files, so the original bytes stay untouched.
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(raw) != "{not json" {
		t.Fatalf("malformed config file was modified; got %q", raw)
	}
}

func TestShadowCallSettingsAbsentSection(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{"port": 18080}`)
	cfg, err := LoadFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	view := cfg.ShadowCallSettingsView()
	if view.Enabled {
		t.Fatal("enabled must be false when the section is absent")
	}
	if view.Model != "" {
		t.Fatalf("model must be the empty string when the section is absent, got %#v", view.Model)
	}
	if got := strings.Join(view.SourceModels, ","); got != "gpt-5.6-luna" {
		t.Fatalf("sourceModels = %q, want the TS default gpt-5.6-luna", got)
	}
}

func TestShadowCallSettingsProjectionMatchesTypeScript(t *testing.T) {
	dir := t.TempDir()
	// Includes the coercions the TS handler performs: enabled only when === true,
	// model kept verbatim (spaces included, null collapses to ""), sourceModels
	// filtered to non-empty trimmed strings with non-string entries dropped.
	writeFixture(t, dir, `{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "  gpt-5.5  ",
    "sourceModels": [" gpt-5.4-mini ", "", 42, "gpt-6-terra"]
  }
}`)
	cfg, err := LoadFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	view := cfg.ShadowCallSettingsView()
	if !view.Enabled {
		t.Fatal("enabled must be true")
	}
	if view.Model != "  gpt-5.5  " {
		t.Fatalf("model must be echoed verbatim, got %#v", view.Model)
	}
	if got := strings.Join(view.SourceModels, ","); got != "gpt-5.4-mini,gpt-6-terra" {
		t.Fatalf("sourceModels = %q, want gpt-5.4-mini,gpt-6-terra (42 and the empty entry dropped)", got)
	}
}

func TestShadowCallSettingsEnabledNonBooleanAndNullModel(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{
  "shadowCallIntercept": { "enabled": "yes", "model": null, "sourceModels": [] }
}`)
	cfg, err := LoadFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	view := cfg.ShadowCallSettingsView()
	if view.Enabled {
		t.Fatal(`enabled must be false for the string "yes" (sci.enabled === true)`)
	}
	if view.Model != "" {
		t.Fatalf("null model must collapse to the empty string, got %#v", view.Model)
	}
	// An empty configured array falls back to the default list.
	if got := strings.Join(view.SourceModels, ","); got != "gpt-5.6-luna" {
		t.Fatalf("sourceModels = %q, want the default after an empty array", got)
	}
}

func TestDirHonoursOpenCodexHome(t *testing.T) {
	t.Setenv("OPENCODEX_HOME", "/tmp/ocx-home-probe")
	dir, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != "/tmp/ocx-home-probe" {
		t.Fatalf("Dir() = %q, want the OPENCODEX_HOME value", dir)
	}
}

func TestDirFallsBackToHomeDotOpenCodex(t *testing.T) {
	t.Setenv("OPENCODEX_HOME", "")
	dir, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".opencodex")
	if dir != want {
		t.Fatalf("Dir() = %q, want %q", dir, want)
	}
}
