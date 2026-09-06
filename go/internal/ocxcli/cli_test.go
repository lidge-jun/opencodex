package ocxcli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const testSecret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"

func testServer(t *testing.T, readyStatus string, validProof bool) (*httptest.Server, RuntimeState) {
	t.Helper()
	state := RuntimeState{PID: 4242, AttestationSecret: testSecret}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			proof := managementauth.CreateLocalAttestationProof(testSecret, r.Header.Get(attestationChallengeHeader), state.PID, state.Port)
			if !validProof {
				proof = strings.Repeat("x", 43)
			}
			w.Header().Set(attestationProofHeader, proof)
			json.NewEncoder(w).Encode(Health{Status: "ok", Service: "opencodex", Version: "2.42.0", Uptime: 1, PID: state.PID, Port: state.Port})
		case "/readyz":
			if readyStatus == "ready" {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
			json.NewEncoder(w).Encode(readiness{Service: "opencodex", Version: "2.42.0", Uptime: 1, PID: state.PID, Port: state.Port, Status: readyStatus})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	state.Port = serverPort(strings.TrimPrefix(server.URL, "http://"))
	return server, state
}

func serverPort(host string) int {
	_, raw, _ := net.SplitHostPort(host)
	var port int
	_, _ = fmt.Sscanf(raw, "%d", &port)
	return port
}

func depsFor(state RuntimeState, stdout, stderr *bytes.Buffer) Deps {
	return Deps{Version: "2.42.0", Stdout: stdout, Stderr: stderr, ReadRuntime: func() (RuntimeState, error) { return state, nil }}
}

func TestVersionAndRegistry(t *testing.T) {
	var out, err bytes.Buffer
	if got := Run([]string{"--version"}, depsFor(RuntimeState{}, &out, &err)); got != ExitOK || out.String() != "opencodex 2.42.0\n" {
		t.Fatalf("version = code %d stdout %q", got, out.String())
	}
	if len(Commands) != 10 || Commands[0].Name != "health" || Commands[1].Name != "ready" || Commands[2].Name != "status" || Commands[3].Name != "doctor" || Commands[4].Name != "service" || Commands[5].Name != "codex-shim" || Commands[6].Name != "tray" || Commands[7].Name != "config" || Commands[8].Name != "models" || Commands[9].Name != "provider" {
		t.Fatalf("unexpected command registry: %#v", Commands)
	}
}

func TestLifecycleFamiliesDelegateExactArgumentsAndExitCode(t *testing.T) {
	for _, argv := range [][]string{
		{"status", "--json"}, {"doctor", "--json"}, {"service", "restart"},
		{"codex-shim", "status"}, {"tray", "status"},
	} {
		t.Run(strings.Join(argv, " "), func(t *testing.T) {
			var received []string
			deps := depsFor(RuntimeState{}, &bytes.Buffer{}, &bytes.Buffer{})
			deps.Delegate = func(args []string) (int, error) {
				received = append([]string(nil), args...)
				return 17, nil
			}
			if got := Run(argv, deps); got != 17 {
				t.Fatalf("exit code = %d, want delegated 17", got)
			}
			if !slices.Equal(received, argv) {
				t.Fatalf("delegated argv = %#v, want %#v", received, argv)
			}
		})
	}
}

func TestLifecycleDelegateFailureIsReported(t *testing.T) {
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { return 0, errors.New("owner unavailable") }
	if got := Run([]string{"service", "status"}, deps); got != ExitFailure || stderr.String() != "owner unavailable\n" {
		t.Fatalf("delegate failure = code %d stderr %q", got, stderr.String())
	}
}

func TestReadOnlyFamilyHelp(t *testing.T) {
	for _, command := range []string{"status", "doctor", "service", "codex-shim", "tray"} {
		t.Run(command, func(t *testing.T) {
			var out, stderr bytes.Buffer
			if got := Run([]string{"help", command}, depsFor(RuntimeState{}, &out, &stderr)); got != ExitOK {
				t.Fatalf("help exit = %d stderr %q", got, stderr.String())
			}
			if !strings.Contains(out.String(), "Usage: ocx "+command) {
				t.Fatalf("help output = %q", out.String())
			}
		})
	}
}

func TestHealthRequiresValidAttestationProof(t *testing.T) {
	server, state := testServer(t, "ready", true)
	defer server.Close()
	var out, stderr bytes.Buffer
	if got := Run([]string{"health", "--json"}, depsFor(state, &out, &stderr)); got != ExitOK {
		t.Fatalf("health exit = %d stderr %s", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"ok\":true") {
		t.Fatalf("health output %q", out.String())
	}
	server.Close()
	server, state = testServer(t, "ready", false)
	defer server.Close()
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"health"}, depsFor(state, &out, &stderr)); got != ExitFailure {
		t.Fatalf("bad proof exit = %d", got)
	}
}

func TestReadyAndUsageExitCodes(t *testing.T) {
	server, state := testServer(t, "ready", true)
	defer server.Close()
	var out, stderr bytes.Buffer
	if got := Run([]string{"ready", "--json"}, depsFor(state, &out, &stderr)); got != ExitOK || !strings.Contains(out.String(), "\"ready\":true") {
		t.Fatalf("ready = %d %q", got, out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"ready", "--timeout", "5"}, depsFor(state, &out, &stderr)); got != ExitUsage {
		t.Fatalf("invalid ready = %d", got)
	}
}

func TestProviderMutationsPersistConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := "{\"providers\":{\"openai\":{\"adapter\":\"openai-responses\",\"baseUrl\":\"https://example.test/v1\"}},\"defaultProvider\":\"openai\"}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	if got := Run([]string{"provider", "add", "test", "--adapter", "openai-chat", "--base-url", "https://test.invalid/v1", "--api-key", "secret", "--set-default"}, deps); got != ExitOK {
		t.Fatalf("add = %d stderr=%q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "Provider \"test\" added.") {
		t.Fatalf("add output = %q", out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"provider", "set-default", "openai", "--json"}, deps); got != ExitOK {
		t.Fatalf("set-default = %d stderr=%q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"action\": \"set-default\"") {
		t.Fatalf("default JSON = %q", out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"provider", "remove", "test", "--json"}, deps); got != ExitOK {
		t.Fatalf("remove = %d stderr=%q", got, stderr.String())
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	providers := cfg.Raw["providers"].(map[string]any)
	if _, ok := providers["test"]; ok {
		t.Fatal("removed provider persisted")
	}
}

func TestCustomModelLifecyclePersistsConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := "{\"providers\":{\"test\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\"}},\"defaultProvider\":\"test\"}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	if got := Run([]string{"models", "add", "test", "model/a"}, deps); got != ExitOK {
		t.Fatalf("add = %d stderr=%q", got, stderr.String())
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	models := cfg.Raw["customModels"].([]any)
	if len(models) != 1 {
		t.Fatalf("customModels = %#v", models)
	}
	model := models[0].(map[string]any)
	if model["modelId"] != "model/a" {
		t.Fatalf("model = %#v", model)
	}
	id := model["id"].(string)
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"models", "list-custom", "--json"}, deps); got != ExitOK || !strings.Contains(out.String(), "\"modelId\": \"model/a\"") {
		t.Fatalf("list = %d output=%q stderr=%q", got, out.String(), stderr.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"models", "remove", id, "--yes"}, deps); got != ExitOK {
		t.Fatalf("remove = %d stderr=%q", got, stderr.String())
	}
	cfg, err = config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Raw["customModels"]; ok {
		t.Fatal("empty customModels should be omitted")
	}
}

func TestProviderRegistrySeedAndPresentationParity(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward"}},"defaultProvider":"openai"}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	if got := Run([]string{"provider", "add", "deepseek", "--api-key", "sk-test", "--json"}, deps); got != ExitOK {
		t.Fatalf("registry add = %d stderr=%q", got, stderr.String())
	}
	var added map[string]any
	if err := json.Unmarshal(out.Bytes(), &added); err != nil {
		t.Fatal(err)
	}
	if added["source"] != "registry" || added["adapter"] != "openai-chat" || added["provider"] != "deepseek" {
		t.Fatalf("added = %#v", added)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	seed := cfg.Raw["providers"].(map[string]any)["deepseek"].(map[string]any)
	if seed["baseUrl"] != "https://api.deepseek.com" || seed["apiKey"] != "sk-test" || seed["authMode"] != "key" {
		t.Fatalf("seed = %#v", seed)
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"provider", "list", "--json"}, deps); got != ExitOK {
		t.Fatalf("list = %d stderr=%q", got, stderr.String())
	}
	var listed providerListOutput
	if err := json.Unmarshal(out.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if listed.RegistryCount != len(providerRegistry) || len(listed.Configured) != 2 || listed.Configured[0].Name != "deepseek" || listed.Configured[0].Source != "registry" {
		t.Fatalf("listed = %#v", listed)
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"provider", "show", "deepseek"}, deps); got != ExitOK || strings.Contains(out.String(), "sk-test") || !strings.Contains(out.String(), "****") {
		t.Fatalf("show = %d stdout=%q stderr=%q", got, out.String(), stderr.String())
	}
}

func TestProviderRemoveHonorsComboAndCustomModels(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := `{"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://example.test/v1"},"fixture":{"adapter":"openai-chat","baseUrl":"https://fixture.test/v1"}},"defaultProvider":"openai","combos":{"blocked":{"targets":[{"provider":"fixture","model":"m"}]}},"customModels":[{"id":"drop","provider":"fixture","modelId":"m"}]}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	if got := Run([]string{"provider", "remove", "fixture"}, deps); got != ExitFailure || !strings.Contains(stderr.String(), "combo(s) depend") {
		t.Fatalf("combo removal = %d stdout=%q stderr=%q", got, out.String(), stderr.String())
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	delete(cfg.Raw["combos"].(map[string]any), "blocked")
	if err := config.SaveRaw(cfg.Raw); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"provider", "remove", "fixture", "--json"}, deps); got != ExitOK {
		t.Fatalf("remove = %d stderr=%q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"droppedCustomModels\": 1") {
		t.Fatalf("remove JSON = %q", out.String())
	}
	cfg, err = config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Raw["customModels"]; ok {
		t.Fatal("provider custom models should be removed")
	}
}

func TestProviderRuntimeVerbsDelegate(t *testing.T) {
	for _, sub := range []string{"edit", "update", "test", "quota", "presets", "account-mode", "selected", "keychain"} {
		t.Run(sub, func(t *testing.T) {
			var received []string
			deps := depsFor(RuntimeState{}, &bytes.Buffer{}, &bytes.Buffer{})
			deps.Delegate = func(args []string) (int, error) { received = append([]string(nil), args...); return 17, nil }
			if got := Run([]string{"provider", sub, "fixture"}, deps); got != 17 {
				t.Fatalf("exit = %d", got)
			}
			want := []string{"provider", sub, "fixture"}
			if !slices.Equal(received, want) {
				t.Fatalf("delegated = %#v want %#v", received, want)
			}
		})
	}
}
