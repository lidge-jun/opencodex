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
	if len(Commands) < 50 {
		t.Fatalf("incomplete command registry: %#v", Commands)
	}
}

func TestOwnershipMapMatchesDispatch(t *testing.T) {
	for _, command := range Commands {
		for _, name := range append([]string{command.Name}, command.Aliases...) {
			t.Run(name, func(t *testing.T) {
				var delegated []string
				deps := depsFor(RuntimeState{}, &bytes.Buffer{}, &bytes.Buffer{})
				deps.Delegate = func(args []string) (int, error) {
					delegated = append([]string(nil), args...)
					return 17, nil
				}
				owner, known := OwnershipFor([]string{name})
				if !known || owner != command.Owner {
					t.Fatalf("OwnershipFor(%q) = %q, %t; want %q, true", name, owner, known, command.Owner)
				}
				got := Run([]string{name}, deps)
				if command.Owner == TypeScriptOwned {
					if got != 17 || !slices.Equal(delegated, []string{name}) {
						t.Fatalf("typescript-owned %q did not delegate: code=%d argv=%#v", name, got, delegated)
					}
				} else if len(delegated) != 0 {
					t.Fatalf("go-owned %q delegated argv=%#v", name, delegated)
				}
			})
		}
	}
}

func TestModelRuntimeOwnershipDelegates(t *testing.T) {
	for subcommand, owner := range modelRuntimeSubcommands {
		if owner != TypeScriptOwned {
			t.Fatalf("models %s owner = %q, want typescript-owned", subcommand, owner)
		}
		if got, known := OwnershipFor([]string{"models", subcommand}); !known || got != TypeScriptOwned {
			t.Fatalf("OwnershipFor(models %s) = %q, %t", subcommand, got, known)
		}
	}
}

func TestConfigRuntimeOwnershipUsesNativeReadCommands(t *testing.T) {
	for _, subcommand := range []string{"show", "validate", "export"} {
		if got, known := OwnershipFor([]string{"config", subcommand}); !known || got != GoOwned {
			t.Fatalf("OwnershipFor(config %s) = %q, %t", subcommand, got, known)
		}
	}
	for _, subcommand := range []string{"get", "set", "unset", "import"} {
		if got, known := OwnershipFor([]string{"config", subcommand}); !known || got != TypeScriptOwned {
			t.Fatalf("OwnershipFor(config %s) = %q, %t", subcommand, got, known)
		}
	}
}

func TestNativeConfigReadCommandsMatchOracleShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := "{\"providers\":{\"test\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\",\"apiKey\":\"secret\",\"defaultModel\":\"m\"}},\"defaultProvider\":\"test\",\"port\":10123,\"unknown\":true}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("native config read delegated"); return 0, nil }
	if got := Run([]string{"config", "show", "--source"}, deps); got != ExitOK {
		t.Fatalf("show = %d stderr=%q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"apiKey\": \"********\"") || !strings.Contains(out.String(), "\"source\": \"file\"") {
		t.Fatalf("show = %q", out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"config", "validate", "--json"}, deps); got != ExitOK {
		t.Fatalf("validate = %d stdout=%q stderr=%q", got, out.String(), stderr.String())
	}
	if !strings.Contains(out.String(), "\"ok\": true") || !strings.Contains(out.String(), filepath.Join(dir, "config.json")) {
		t.Fatalf("validate = %q", out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"config", "export", "-"}, deps); got != ExitOK {
		t.Fatalf("export = %d stderr=%q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"apiKey\": \"secret\"") || !strings.Contains(out.String(), "\"unknown\": true") {
		t.Fatalf("export = %q", out.String())
	}
}

func TestNativeConfigCandidateValidationMatchesMultiIssueOracle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{\"port\":-1}"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("candidate validation delegated"); return 0, nil }
	if got := Run([]string{"config", "validate", path, "--json"}, deps); got != ExitOK {
		t.Fatalf("validate = %d", got)
	}
	want := "{\n  \"ok\": false,\n  \"error\": \"schema_invalid: port: Too small: expected number to be >=0; providers: Invalid input: expected record, received undefined\"\n}\n"
	if out.String() != want {
		t.Fatalf("stdout = %q, want %q", out.String(), want)
	}
}

func TestNativeConfigReadFallsBackForUnreadableStoredConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	var out, stderr bytes.Buffer
	var received []string
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func(args []string) (int, error) { received = append([]string(nil), args...); return 17, nil }
	if got := Run([]string{"config", "show", "--source"}, deps); got != 17 {
		t.Fatalf("show = %d", got)
	}
	if want := []string{"config", "show", "--source"}; !slices.Equal(received, want) {
		t.Fatalf("fallback argv=%#v want=%#v", received, want)
	}
}

func TestHelpSurfaceMatchesCommandRegistry(t *testing.T) {
	documented := map[string]bool{}
	for _, line := range strings.Split(fullUsage, "\n") {
		if !strings.HasPrefix(line, "  ocx ") {
			continue
		}
		fields := strings.Fields(strings.TrimPrefix(strings.TrimSpace(line), "ocx "))
		if len(fields) > 0 {
			documented[fields[0]] = true
		}
	}
	for name := range documented {
		if name == "help" || name == "--version" {
			continue // Dispatch-head entries never select an implementation owner.
		}
		if _, ok := commandForName(name); !ok {
			t.Fatalf("help documents %q but ownership registry has no command", name)
		}
	}
	for _, command := range Commands {
		found := documented[command.Name]
		for _, alias := range command.Aliases {
			found = found || documented[alias]
		}
		if !found {
			t.Fatalf("ownership registry command %q is missing from top-level help", command.Name)
		}
	}
}

func TestTypeScriptOwnedFamiliesDelegateExactArgumentsAndExitCode(t *testing.T) {
	for _, argv := range [][]string{
		{"status", "--json"}, {"doctor", "--json"}, {"service", "restart"},
		{"codex-shim", "status"}, {"tray", "status"},
		{"config", "set", "port", "10101", "--json"},
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

func TestConfigHelpIsNative(t *testing.T) {
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("config help delegated"); return 0, nil }
	if got := Run([]string{"help", "config"}, deps); got != ExitOK {
		t.Fatalf("help config exit = %d", got)
	}
	if out.String() != configHelp {
		t.Fatalf("help = %q", out.String())
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

func TestTypeScriptOwnedFamilyHelpDelegates(t *testing.T) {
	for _, command := range []string{"codex-shim", "tray"} {
		t.Run(command, func(t *testing.T) {
			var out, stderr bytes.Buffer
			var received []string
			deps := depsFor(RuntimeState{}, &out, &stderr)
			deps.Delegate = func(args []string) (int, error) {
				received = append([]string(nil), args...)
				return ExitOK, nil
			}
			if got := Run([]string{"help", command}, deps); got != ExitOK {
				t.Fatalf("help exit = %d stderr %q", got, stderr.String())
			}
			if want := []string{command, "--help"}; !slices.Equal(received, want) {
				t.Fatalf("delegated argv = %#v, want %#v", received, want)
			}
		})
	}
}

func TestDelegatedFamilyHelpUsesOwnerOutput(t *testing.T) {
	for _, command := range []string{"status", "doctor", "service"} {
		t.Run(command, func(t *testing.T) {
			var received []string
			deps := depsFor(RuntimeState{}, &bytes.Buffer{}, &bytes.Buffer{})
			deps.Delegate = func(args []string) (int, error) {
				received = append([]string(nil), args...)
				return ExitOK, nil
			}
			if got := Run([]string{"help", command}, deps); got != ExitOK {
				t.Fatalf("help exit = %d", got)
			}
			want := []string{command, "--help"}
			if !slices.Equal(received, want) {
				t.Fatalf("delegated argv = %#v, want %#v", received, want)
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

func TestCustomModelMetadataAndSelectorParity(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := "{\"providers\":{\"test\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\",\"models\":[\"native-id\"]}},\"defaultProvider\":\"test\"}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	argv := []string{"models", "add", "test", "openai/gpt-5.5", "--display-name", "GPT", "--context-window", "128000", "--modalities", "text,image", "--reasoning-efforts", "high,low,high", "--default-reasoning-effort", "high"}
	if got := Run(argv, deps); got != ExitOK {
		t.Fatalf("add = %d stderr=%q", got, stderr.String())
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	model := cfg.Raw["customModels"].([]any)[0].(map[string]any)
	if model["displayName"] != "GPT" || model["contextWindow"] != json.Number("128000") {
		t.Fatalf("metadata = %#v", model)
	}
	if got := fmt.Sprint(model["inputModalities"]); got != "[text image]" {
		t.Fatalf("modalities = %s", got)
	}
	if got := fmt.Sprint(model["reasoningEfforts"]); got != "[low high]" {
		t.Fatalf("efforts = %s", got)
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"models", "remove", "test/openai/gpt-5.5", "--yes"}, deps); got != ExitOK {
		t.Fatalf("raw selector remove = %d stderr=%q", got, stderr.String())
	}
}

func TestCustomModelRejectsEncodedCollisionAndAmbiguousRemoval(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := "{\"providers\":{\"test\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\",\"defaultModel\":\"openai-gpt-5.5\"}},\"defaultProvider\":\"test\"}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	if got := Run([]string{"models", "add", "test", "openai/gpt-5.5"}, deps); got != ExitFailure || !strings.Contains(stderr.String(), "ambiguous") {
		t.Fatalf("collision add = %d stderr=%q", got, stderr.String())
	}
	initial = "{\"providers\":{\"test\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\"}},\"defaultProvider\":\"test\",\"customModels\":[{\"id\":\"11111111-1111-4111-8111-111111111111\",\"provider\":\"test\",\"modelId\":\"openai/gpt-5.5\"},{\"id\":\"22222222-2222-4222-8222-222222222222\",\"provider\":\"test\",\"modelId\":\"openai-gpt-5.5\"}]}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"models", "remove", "test/openai/gpt-5.5", "--yes"}, deps); got != ExitFailure || !strings.Contains(stderr.String(), "ambiguous") {
		t.Fatalf("ambiguous remove = %d stderr=%q", got, stderr.String())
	}
}

func TestModelsRuntimeCommandsDelegateToTypeScriptOwner(t *testing.T) {
	var received []string
	deps := depsFor(RuntimeState{}, &bytes.Buffer{}, &bytes.Buffer{})
	deps.Delegate = func(args []string) (int, error) { received = append([]string(nil), args...); return 17, nil }
	if got := Run([]string{"models", "new-arrivals", "--json"}, deps); got != 17 {
		t.Fatalf("exit = %d", got)
	}
	if !slices.Equal(received, []string{"models", "new-arrivals", "--json"}) {
		t.Fatalf("delegated argv = %#v", received)
	}
}

func TestModelsMetadataResolvesRuntimeStyleFamilyRules(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	initial := "{\"providers\":{\"test\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\",\"defaultModel\":\"gpt-oss:120b\",\"modelContextWindows\":{\"gpt-oss\":131000},\"noVisionModels\":[\"gpt-oss\"],\"modelInputModalities\":{\"gpt-oss:120b\":[\"text\",\"image\"]},\"modelReasoningEfforts\":{\"gpt-oss\":[\"high\",\"bogus\",\"low\"]}}},\"defaultProvider\":\"test\"}"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	if got := Run([]string{"models", "--json"}, depsFor(RuntimeState{}, &out, &stderr)); got != ExitOK {
		t.Fatalf("models = %d stderr=%q", got, stderr.String())
	}
	var response struct {
		Models []modelOutput `json:"models"`
	}
	if err := json.Unmarshal(out.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Models) != 1 {
		t.Fatalf("models = %#v", response.Models)
	}
	row := response.Models[0]
	if fmt.Sprint(row.ContextWindow) != "131000" || fmt.Sprint(row.InputModalities) != "[text]" || fmt.Sprint(row.ReasoningEfforts) != "[low high]" {
		t.Fatalf("row = %#v", row)
	}
}
