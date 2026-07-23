package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestConfigLoadSaveRoundTripAndEnvironmentExpansion(t *testing.T) {
	t.Setenv("OCX_TEST_KEY", `key-with-"quotes"`)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := Default()
	cfg.AuthToken = "${OCX_TEST_KEY}"
	cfg.Providers["test"] = ProviderConfig{
		Adapter: "openai-chat",
		BaseURL: "https://example.com/v1",
		APIKey:  "$OCX_TEST_KEY",
	}
	cfg.DefaultProvider = "test"
	cfg.Debug.Enabled = true
	cfg.Log.Level = "debug"

	if err := Save(path, &cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("config permissions = %o, want 600", got)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	wantSecret := `key-with-"quotes"`
	if loaded.AuthToken != wantSecret || loaded.Providers["test"].APIKey != wantSecret {
		t.Fatalf("environment expansion failed: %#v", loaded)
	}

	expected := cfg
	expected.AuthToken = wantSecret
	provider := expected.Providers["test"]
	provider.APIKey = wantSecret
	expected.Providers["test"] = provider
	if !reflect.DeepEqual(*loaded, expected) {
		t.Fatalf("round trip mismatch\n got: %#v\nwant: %#v", *loaded, expected)
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"port":70000,"hostname":"127.0.0.1","providers":{},"defaultProvider":"openai"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); !IsConfigError(err) {
		t.Fatalf("Load() error = %v, want ConfigError", err)
	}
}
