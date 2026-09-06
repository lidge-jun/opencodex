package ocxcli

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runTypeScriptExternalStatusJSON(t *testing.T, home string, env ...string) []byte {
	t.Helper()
	cmd := exec.Command("bun", "src/cli/index.ts", "status", "--json")
	cmd.Dir = typeScriptOracleRepo(t)
	clean := make([]string, 0, len(os.Environ())+3+len(env))
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "HOME=") && !strings.HasPrefix(item, "OPENCODEX_HOME=") && !strings.HasPrefix(item, "CODEX_HOME=") {
			clean = append(clean, item)
		}
	}
	cmd.Env = append(clean, append([]string{"HOME=" + home, "OPENCODEX_HOME=" + home, "CODEX_HOME=" + filepath.Join(home, "codex")}, env...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript external status oracle: %v: %s", err, out)
	}
	// A deliberately unhealthy shim makes TypeScript print its recovery warning
	// before JSON. The status payload remains the differential contract here.
	if start := bytes.IndexByte(out, '{'); start >= 0 {
		return out[start:]
	}
	t.Fatalf("TypeScript external status oracle returned no JSON: %s", out)
	return nil
}

func statusExternalDomainBytes(t *testing.T, full []byte) []byte {
	t.Helper()
	var compact bytes.Buffer
	if err := json.Compact(&compact, full); err != nil {
		t.Fatalf("compact external oracle: %v; output=%s", err, full)
	}
	var status struct {
		Service       json.RawMessage `json:"service"`
		CodexShim     json.RawMessage `json:"codexShim"`
		CodexPlugins  json.RawMessage `json:"codexPlugins"`
		CodexRuntime  json.RawMessage `json:"codexRuntime"`
		CodexHome     json.RawMessage `json:"codexHome"`
		ClaudeDesktop json.RawMessage `json:"claudeDesktop"`
	}
	if err := json.Unmarshal(compact.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	return []byte("{\"service\":" + string(status.Service) + ",\"codexShim\":" + string(status.CodexShim) + ",\"codexPlugins\":" + string(status.CodexPlugins) + ",\"codexRuntime\":" + string(status.CodexRuntime) + ",\"codexHome\":" + string(status.CodexHome) + ",\"claudeDesktop\":" + string(status.ClaudeDesktop) + "}")
}

func TestStatusExternalDomainsMatchTypeScriptOracle(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	runtimePath := filepath.Join(home, "codex-runtime")
	if err := os.WriteFile(runtimePath, []byte("#!/bin/sh\nprintf 'codex-cli 999.0.0\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	wrapperPath := filepath.Join(home, "codex-wrapper")
	backupPath := filepath.Join(home, "codex-backup")
	if err := os.WriteFile(wrapperPath, []byte("# opencodex codex autostart shim\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupPath, []byte("original"), 0o700); err != nil {
		t.Fatal(err)
	}
	shim := "{\"platform\":\"linux\",\"wrapperPath\":\"" + wrapperPath + "\",\"originalPath\":\"" + wrapperPath + "\",\"backupPath\":\"" + backupPath + "\"}"
	if err := os.WriteFile(filepath.Join(home, "codex-shim.json"), []byte(shim), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{\"clientIntegrations\":{\"claude-desktop\":false}}"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("CODEX_CLI_PATH", runtimePath)
	oracle := runTypeScriptExternalStatusJSON(t, home, "CODEX_CLI_PATH="+runtimePath)
	want := statusExternalDomainBytes(t, oracle)
	got, err := json.Marshal(CollectStatusExternalDomains())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("external domain bytes\\n got: %s\\nwant: %s", got, want)
	}
}
