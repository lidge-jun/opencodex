package ocxcli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestStatusCommandAssemblyJSONMatchesTypeScriptOracle compares the complete
// public JSON payload byte-for-byte after native status ownership.
func TestStatusCommandAssemblyJSONMatchesTypeScriptOracle(t *testing.T) {
	if owner, known := OwnershipFor([]string{"status"}); !known || owner != GoOwned {
		t.Fatalf("status ownership = %q, %t; want Go-owned", owner, known)
	}
	for _, scenario := range []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{"default config", func(*testing.T, string) {}},
		{"custom config", func(t *testing.T, home string) {
			writeStatusOracleFile(t, filepath.Join(home, "config.json"), []byte(`{"port":18080,"hostname":"127.0.0.1","defaultProvider":"fixture","codexAutoStart":false,"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1"}}}`))
		}},
		{"runtime port live proxy", func(t *testing.T, home string) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"service": "opencodex", "status": "ok", "version": "2.42.0", "uptime": 1, "pid": os.Getpid()})
			}))
			t.Cleanup(server.Close)
			port := serverPort(strings.TrimPrefix(server.URL, "http://"))
			writeStatusOracleFile(t, filepath.Join(home, "ocx.pid"), []byte(fmt.Sprintf("%d\n", os.Getpid())))
			writeStatusOracleFile(t, filepath.Join(home, "runtime-port.json"), []byte(fmt.Sprintf(`{"pid":%d,"port":%d,"hostname":"127.0.0.1"}`, os.Getpid(), port)))
		}},
		{"malformed config", func(t *testing.T, home string) {
			writeStatusOracleFile(t, filepath.Join(home, "config.json"), []byte(`{not-json`))
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			home := t.TempDir()
			if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
				t.Fatal(err)
			}
			runtimePath := filepath.Join(home, "codex-runtime")
			writeStatusOracleFile(t, runtimePath, []byte("#!/bin/sh\nprintf 'codex-cli 999.0.0\\n'\n"))
			if err := os.Chmod(runtimePath, 0o700); err != nil {
				t.Fatal(err)
			}
			scenario.setup(t, home)
			t.Setenv("HOME", home)
			t.Setenv("OPENCODEX_HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
			t.Setenv("CODEX_CLI_PATH", runtimePath)
			oracle := runTypeScriptStatusJSON(t, home)
			if got := marshalStatusCommandOracle(t, oracle); got != string(oracle) {
				t.Fatalf("%s full JSON differs from TypeScript oracle\nGo:\n%s\nTypeScript:\n%s", scenario.name, got, oracle)
			}
		})
	}
}

func TestStatusCommandTextMatchesTypeScriptOracleForUnavailableCodexHealth(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("CODEX_CLI_PATH", "/bin/false")
	repo := typeScriptOracleRepo(t)
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(repo); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	result := runTypeScriptStatusCommandText(t, repo, home)
	var out, stderr bytes.Buffer
	if code := Run([]string{"status"}, Deps{Stdout: &out, Stderr: &stderr}); code != ExitOK {
		t.Fatalf("native status exit = %d, stderr=%s", code, stderr.String())
	}
	if out.String() != result {
		t.Fatalf("text status differs from TypeScript oracle\\nGo:\\n%s\\nTypeScript:\\n%s", out.String(), result)
	}
}

func TestStatusMalformedConfigWritesTypeScriptCompatibleBackup(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.json")
	raw := []byte("{not-json")
	writeStatusOracleFile(t, path, raw)
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	var out, stderr bytes.Buffer
	if code := Run([]string{"status"}, Deps{Stdout: &out, Stderr: &stderr}); code != ExitOK {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stderr.String(), "Could not load opencodex config at "+path) || !strings.Contains(stderr.String(), "Using default config. A backup was written to ") {
		t.Fatalf("stderr = %q", stderr.String())
	}
	matches, err := filepath.Glob(path + ".invalid-*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("backups = %v, %v", matches, err)
	}
	got, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, raw) {
		t.Fatalf("backup bytes = %q, want %q", got, raw)
	}
}

func marshalStatusCommandOracle(t *testing.T, oracle []byte) string {
	t.Helper()
	var runtime struct {
		Paths struct {
			Runtime string `json:"runtime"`
		} `json:"paths"`
		Runtime struct {
			Source      string  `json:"source"`
			OverrideEnv *string `json:"overrideEnv"`
		} `json:"runtime"`
	}
	if err := json.Unmarshal(oracle, &runtime); err != nil {
		t.Fatal(err)
	}
	value := CollectStatusCommand(StatusCommandDeps{Domains: StatusDomainDeps{
		CLIVersion: "2.42.0",
		ReadBunRuntime: func() StatusBunRuntime {
			return StatusBunRuntime{Path: runtime.Paths.Runtime, Source: runtime.Runtime.Source, OverrideEnv: runtime.Runtime.OverrideEnv}
		},
	}})
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		t.Fatal(err)
	}
	return output.String()
}

func runTypeScriptStatusCommandText(t *testing.T, repo, home string) string {
	t.Helper()
	cmd := exec.Command("bun", "src/cli/index.ts", "status")
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "HOME="+home, "OPENCODEX_HOME="+home, "CODEX_HOME="+filepath.Join(home, "codex"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript text status oracle: %v: %s", err, out)
	}
	return string(out)
}

func writeStatusOracleFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
