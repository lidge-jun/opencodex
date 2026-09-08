package ocxcli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// keyLoginTestEnv isolates OPENCODEX_HOME and returns deps plus output buffers.
func keyLoginTestEnv(t *testing.T) (Deps, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	t.Setenv("OPENCODEX_HOME", t.TempDir())
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func(args []string) (int, error) {
		t.Fatalf("key login delegated argv=%#v", args)
		return 0, nil
	}
	return deps, &out, &stderr
}

// keyLoginConfigPath returns the isolated config.json path.

func writeKeyLoginConfig(t *testing.T, path string, raw map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readKeyLoginConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

// TestKeyLoginUnknownProviderDelegates pins that an unknown provider never
// reaches the Go flow: OwnershipFor sends it to the TypeScript owner, and the
// Go dispatch must have no login branch that could swallow it.
func TestKeyLoginUnknownProviderDelegates(t *testing.T) {
	deps, _, stderr := keyLoginTestEnv(t)
	deps.Delegate = func(args []string) (int, error) {
		if len(args) != 2 || args[0] != "login" || args[1] != "unknown-provider" {
			t.Fatalf("delegate argv=%#v", args)
		}
		return 7, nil
	}
	if got := Run([]string{"login", "unknown-provider"}, deps); got != 7 {
		t.Fatalf("Run(login unknown-provider) = %d; want 7 (delegated)", got)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q; want empty", stderr.String())
	}
}

// TestKeyLoginCollidesWithCodexNamespace pins story 4: a namespace collision
// aborts with the exact TypeScript error before any browser or prompt.
func TestKeyLoginCollidesWithCodexNamespace(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	writeKeyLoginConfig(t, filepath.Join(home, "config.json"), map[string]any{
		"codexAccountNamespaces": map[string]any{"zai": map[string]any{}},
	})
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func(args []string) (int, error) {
		t.Fatalf("key login delegated argv=%#v", args)
		return 0, nil
	}
	deps.Stdin = strings.NewReader("key\n")
	deps.OpenURL = func(url string) {
		t.Fatal("browser must not open on a namespace collision")
	}
	if got := Run([]string{"login", "zai"}, deps); got != ExitFailure {
		t.Fatalf("Run(login zai) with collision = %d; want %d", got, ExitFailure)
	}
	if !strings.Contains(stderr.String(), "provider name must not collide with a configured Codex account namespace") {
		t.Fatalf("stderr = %q; want the namespace collision error", stderr.String())
	}
}

// keyLoginTestServer starts an httptest server that records the probe and
// returns the configured status; it also repoints the zai table entry at the
// server so a full runLogin exercises the real probe URL construction.
func keyLoginTestServer(t *testing.T, status int, wantPath string) (*httptest.Server, *string) {
	t.Helper()
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if wantPath != "" && r.URL.Path != wantPath {
			t.Errorf("probe path = %q; want %q", r.URL.Path, wantPath)
		}
		if status == http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"object":"list","data":[]}`)
			return
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(server.Close)
	original := keyLoginProviders["zai"]
	keyLoginProviders["zai"] = keyLoginProvider{
		Label:        original.Label,
		BaseURL:      server.URL,
		Adapter:      original.Adapter,
		DashboardURL: original.DashboardURL,
		DefaultModel: original.DefaultModel,
	}
	t.Cleanup(func() { keyLoginProviders["zai"] = original })
	return server, &gotPath
}

func TestKeyLoginSuccessPersistsAndPrints(t *testing.T) {
	_, gotPath := keyLoginTestServer(t, http.StatusOK, "/models")
	deps, out, stderr := keyLoginTestEnv(t)
	deps.Stdin = strings.NewReader("sk-secret123\n")
	opened := ""
	deps.OpenURL = func(url string) { opened = url }
	home := os.Getenv("OPENCODEX_HOME")
	if got := Run([]string{"login", "zai"}, deps); got != ExitOK {
		t.Fatalf("Run(login zai) = %d; want %d (stderr=%q)", got, ExitOK, stderr.String())
	}
	if *gotPath != "/models" {
		t.Fatalf("probe path = %q; want /models", *gotPath)
	}
	if opened == "" {
		t.Fatal("OpenURL was not called")
	}
	if !strings.Contains(out.String(), "✅ Z.AI — GLM Coding Plan added. Try: ocx sync") {
		t.Fatalf("stdout = %q; want the success line", out.String())
	}
	cfg := readKeyLoginConfig(t, filepath.Join(home, "config.json"))
	providers, _ := cfg["providers"].(map[string]any)
	row, ok := providers["zai"].(map[string]any)
	if !ok {
		t.Fatalf("providers[zai] missing: %#v", providers)
	}
	if row["adapter"] != "openai-chat" || row["apiKey"] != "sk-secret123" || row["defaultModel"] != "glm-5.3" {
		t.Fatalf("providers[zai] row = %#v", row)
	}
	if got := row["baseUrl"]; got == "" {
		t.Fatal("baseUrl missing in saved row")
	}
}

func TestKeyLoginRejectedKeyNotSaved(t *testing.T) {
	keyLoginTestServer(t, http.StatusUnauthorized, "")
	deps, out, stderr := keyLoginTestEnv(t)
	deps.Stdin = strings.NewReader("sk-bad\n")
	home := os.Getenv("OPENCODEX_HOME")
	if got := Run([]string{"login", "zai"}, deps); got != ExitFailure {
		t.Fatalf("Run(login zai) = %d; want %d", got, ExitFailure)
	}
	if !strings.Contains(out.String(), "INVALID ❌") {
		t.Fatalf("stdout = %q; want the INVALID marker", out.String())
	}
	if !strings.Contains(stderr.String(), "Provider rejected the key. Not saved.") {
		t.Fatalf("stderr = %q; want the rejection error", stderr.String())
	}
	cfg := readKeyLoginConfig(t, filepath.Join(home, "config.json"))
	providers, _ := cfg["providers"].(map[string]any)
	if _, ok := providers["zai"]; ok {
		t.Fatalf("rejected key was persisted: %#v", providers)
	}
}

func TestKeyLoginEmptyKeyAborts(t *testing.T) {
	keyLoginTestServer(t, http.StatusOK, "")
	deps, _, stderr := keyLoginTestEnv(t)
	deps.Stdin = strings.NewReader("\n")
	home := os.Getenv("OPENCODEX_HOME")
	if got := Run([]string{"login", "zai"}, deps); got != ExitFailure {
		t.Fatalf("Run(login zai) empty key = %d; want %d", got, ExitFailure)
	}
	if !strings.Contains(stderr.String(), "No key entered.") {
		t.Fatalf("stderr = %q; want the empty-key error", stderr.String())
	}
	cfg := readKeyLoginConfig(t, filepath.Join(home, "config.json"))
	providers, _ := cfg["providers"].(map[string]any)
	if _, ok := providers["zai"]; ok {
		t.Fatalf("empty key was persisted: %#v", providers)
	}
}

func TestKeyLoginPreservesModelCostsOverlay(t *testing.T) {
	keyLoginTestServer(t, http.StatusOK, "")
	deps, _, _ := keyLoginTestEnv(t)
	deps.Stdin = strings.NewReader("sk-rotated\n")
	home := os.Getenv("OPENCODEX_HOME")
	writeKeyLoginConfig(t, filepath.Join(home, "config.json"), map[string]any{
		"providers": map[string]any{
			"zai": map[string]any{
				"adapter": "openai-chat", "baseUrl": "https://api.z.ai/api/coding/paas/v4",
				"apiKey": "sk-old", "defaultModel": "glm-5.3",
				"modelCosts": map[string]any{"glm-5.3": map[string]any{"input": 1, "output": 2}},
			},
		},
	})
	if got := Run([]string{"login", "zai"}, deps); got != ExitOK {
		t.Fatalf("Run(login zai) = %d; want %d", got, ExitOK)
	}
	cfg := readKeyLoginConfig(t, filepath.Join(home, "config.json"))
	providers, _ := cfg["providers"].(map[string]any)
	row, _ := providers["zai"].(map[string]any)
	if row["apiKey"] != "sk-rotated" {
		t.Fatalf("apiKey not rotated: %#v", row)
	}
	if row["modelCosts"] == nil {
		t.Fatal("modelCosts overlay was dropped by key rotation")
	}
}

func TestKeyLoginProbeSendsBearerAndUnknownOn5xx(t *testing.T) {
	var authHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	deps, out, _ := keyLoginTestEnv(t)
	deps.HTTPClient = server.Client()
	deps.Stdin = strings.NewReader("sk-x\n")
	home := os.Getenv("OPENCODEX_HOME")
	original := keyLoginProviders["zai"]
	keyLoginProviders["zai"] = keyLoginProvider{
		Label: original.Label, BaseURL: server.URL, Adapter: original.Adapter,
		DashboardURL: original.DashboardURL, DefaultModel: original.DefaultModel,
	}
	t.Cleanup(func() { keyLoginProviders["zai"] = original })
	if got := Run([]string{"login", "zai"}, deps); got != ExitOK {
		t.Fatalf("Run(login zai) with 503 = %d; want OK (unknown proceeds)", got)
	}
	if authHeader != "Bearer sk-x" {
		t.Fatalf("Authorization = %q; want Bearer sk-x", authHeader)
	}
	if !strings.Contains(out.String(), "couldn't validate (may still work)") {
		t.Fatalf("stdout = %q; want the unknown marker", out.String())
	}
	cfg := readKeyLoginConfig(t, filepath.Join(home, "config.json"))
	providers, _ := cfg["providers"].(map[string]any)
	if _, ok := providers["zai"]; !ok {
		t.Fatal("unknown-validation key was not persisted")
	}
}
