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
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const testSecret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"

func runTypeScriptStatusJSON(t *testing.T, home string) []byte {
	t.Helper()
	repo := typeScriptOracleRepo(t)
	cmd := exec.Command("bun", "src/cli/index.ts", "status", "--json")
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "OPENCODEX_HOME="+home, "CODEX_HOME="+filepath.Join(home, "codex"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript status oracle: %v: %s", err, out)
	}
	return out
}

// The focused Go worktree intentionally does not install JavaScript packages.
// Use its own dependency tree when present, otherwise discover another local
// checkout with its dependency tree. This keeps the TypeScript oracle local and
// makes an unavailable oracle an explicit skip instead of a machine path.
func typeScriptOracleRepo(t *testing.T) string {
	t.Helper()
	worktree := filepath.Clean(filepath.Join(filepath.Dir(currentTestFile(t)), "..", "..", ".."))
	if info, err := os.Stat(filepath.Join(worktree, "node_modules")); err == nil && info.IsDir() {
		return worktree
	}
	listed, err := exec.Command("git", "-C", worktree, "worktree", "list", "--porcelain").Output()
	if err == nil {
		for _, line := range strings.Split(string(listed), "\n") {
			path, ok := strings.CutPrefix(line, "worktree ")
			if !ok {
				continue
			}
			if info, statErr := os.Stat(filepath.Join(path, "node_modules")); statErr == nil && info.IsDir() {
				return path
			}
		}
	}
	t.Skip("TypeScript status/doctor oracle needs node_modules in this checkout")
	return ""
}

func currentTestFile(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test file")
	}
	return file
}

func statusDomainBytes(t *testing.T, full []byte) []byte {
	t.Helper()
	var compact bytes.Buffer
	if err := json.Compact(&compact, full); err != nil {
		t.Fatalf("compact status oracle: %v; output=%s", err, full)
	}
	var status struct {
		SchemaVersion   json.RawMessage `json:"schemaVersion"`
		Proxy           json.RawMessage `json:"proxy"`
		Dashboard       json.RawMessage `json:"dashboard"`
		Listen          json.RawMessage `json:"listen"`
		Paths           json.RawMessage `json:"paths"`
		Runtime         json.RawMessage `json:"runtime"`
		CodexAutostart  json.RawMessage `json:"codexAutostart"`
		Startup         json.RawMessage `json:"startup"`
		DefaultProvider json.RawMessage `json:"defaultProvider"`
		Config          json.RawMessage `json:"config"`
		Connection      json.RawMessage `json:"connection"`
		VersionSkew     json.RawMessage `json:"versionSkew"`
	}
	if err := json.Unmarshal(compact.Bytes(), &status); err != nil {
		t.Fatalf("decode status oracle: %v; output=%s", err, compact.Bytes())
	}
	return []byte(fmt.Sprintf(
		`{"schemaVersion":%s,"proxy":%s,"dashboard":%s,"listen":%s,"paths":%s,"runtime":%s,"codexAutostart":%s,"startup":%s,"defaultProvider":%s,"config":%s,"connection":%s,"versionSkew":%s}`,
		status.SchemaVersion, status.Proxy, status.Dashboard, status.Listen, status.Paths, status.Runtime, status.CodexAutostart, status.Startup, status.DefaultProvider, status.Config, status.Connection, status.VersionSkew,
	))
}

func statusOracleRuntime(t *testing.T, full []byte) StatusBunRuntime {
	t.Helper()
	var status struct {
		Paths struct {
			Runtime string `json:"runtime"`
		} `json:"paths"`
		Runtime struct {
			Source      string  `json:"source"`
			OverrideEnv *string `json:"overrideEnv"`
		} `json:"runtime"`
	}
	if err := json.Unmarshal(full, &status); err != nil {
		t.Fatalf("decode status runtime oracle: %v", err)
	}
	return StatusBunRuntime{Path: status.Paths.Runtime, Source: status.Runtime.Source, OverrideEnv: status.Runtime.OverrideEnv}
}

func runTypeScriptDoctorProxyHint(t *testing.T, input DoctorProxyDownInput) string {
	t.Helper()
	repo := typeScriptOracleRepo(t)
	script := `import { proxyDownRestartHint } from "./src/cli/doctor";
const value = proxyDownRestartHint(JSON.parse(process.env.OCX_DOCTOR_INPUT));
process.stdout.write(JSON.stringify(value));`
	encoded, err := json.Marshal(map[string]any{
		"proxyRunning": input.ProxyRunning, "port": input.Port, "serviceViable": input.ServiceViable,
		"serviceInstalled": input.ServiceInstalled, "serviceConflict": input.ServiceConflict, "staleProcessState": input.StaleProcessState,
	})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bun", "-e", script)
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "OCX_DOCTOR_INPUT="+string(encoded))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript doctor oracle: %v: %s", err, out)
	}
	var hint *string
	if err := json.Unmarshal(out, &hint); err != nil {
		t.Fatalf("decode doctor oracle: %v; output=%s", err, out)
	}
	if hint == nil {
		return ""
	}
	return *hint
}

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
	for _, subcommand := range []string{"show", "get", "validate", "export", "set", "unset", "import"} {
		if got, known := OwnershipFor([]string{"config", subcommand}); !known || got != GoOwned {
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
		{"doctor", "--json"}, {"service", "restart"},
		{"tray", "status"},
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

func TestNativeConfigWriteCommandsMatchOracleShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	configPath := filepath.Join(dir, "config.json")
	initial := []byte(`{"port":10100,"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1"}},"defaultProvider":"fixture","autoSwitchThreshold":50}`)
	if err := os.WriteFile(configPath, initial, 0o600); err != nil {
		t.Fatal(err)
	}

	run := func(argv []string) (int, string, string) {
		var out, stderr bytes.Buffer
		deps := depsFor(RuntimeState{}, &out, &stderr)
		deps.Delegate = func([]string) (int, error) { t.Fatal("native config write delegated"); return 0, nil }
		return Run(argv, deps), out.String(), stderr.String()
	}
	if code, out, stderr := run([]string{"config", "set", "autoSwitchThreshold", "70", "--json"}); code != ExitOK || out != "{\n  \"ok\": true,\n  \"path\": \"autoSwitchThreshold\",\n  \"value\": 70\n}\n" || stderr != "" {
		t.Fatalf("set = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "unset", "autoSwitchThreshold", "--json"}); code != ExitOK || out != "{\n  \"ok\": true,\n  \"path\": \"autoSwitchThreshold\",\n  \"value\": null\n}\n" || stderr != "" {
		t.Fatalf("unset = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	importPath := filepath.Join(dir, "import.json")
	if err := os.WriteFile(importPath, []byte(`{"port":10102,"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1"}},"defaultProvider":"fixture"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, out, stderr := run([]string{"config", "import", importPath, "--yes", "--json"}); code != ExitOK || out != "{\n  \"ok\": true,\n  \"source\": \""+importPath+"\"\n}\n" || stderr != "" {
		t.Fatalf("import = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "set", "port", "-1", "--json"}); code != 2 || out != "" || stderr != "Error: schema_invalid: port: Too small: expected number to be >=0\n" {
		t.Fatalf("invalid set = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "import", importPath, "--json"}); code != 2 || out != "" || stderr != "Error: import requires --yes\n"+configUsage {
		t.Fatalf("unconfirmed import = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "unset", "missing", "--json"}); code != 2 || out != "" || stderr != "Error: config path not found: missing\n" {
		t.Fatalf("missing unset = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
}

func TestNativeConfigGetMatchesOracleShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	configPath := filepath.Join(dir, "config.json")
	initial := []byte(`{"port":10100,"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"m1","models":["m1","m2"],"contextWindow":128000}},"defaultProvider":"fixture"}`)
	if err := os.WriteFile(configPath, initial, 0o600); err != nil {
		t.Fatal(err)
	}

	run := func(argv []string) (int, string, string) {
		var out, stderr bytes.Buffer
		deps := depsFor(RuntimeState{}, &out, &stderr)
		deps.Delegate = func([]string) (int, error) { t.Fatal("native config get delegated"); return 0, nil }
		return Run(argv, deps), out.String(), stderr.String()
	}
	if code, out, stderr := run([]string{"config", "get", "providers.fixture"}); code != ExitOK || out != "{\n  \"adapter\": \"openai-chat\",\n  \"baseUrl\": \"https://example.test/v1\",\n  \"apiKey\": \"********\",\n  \"defaultModel\": \"m1\",\n  \"models\": [\n    \"m1\",\n    \"m2\"\n  ],\n  \"contextWindow\": 128000\n}\n" || stderr != "" {
		t.Fatalf("object get = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "get", "defaultProvider", "--json"}); code != ExitOK || out != "\"fixture\"\n" || stderr != "" {
		t.Fatalf("scalar get = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "get", "providers.fixture.apiKey", "--json"}); code != ExitOK || out != "\"********\"\n" || stderr != "" {
		t.Fatalf("secret get = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "get", "does.not.exist"}); code != 2 || out != "" || stderr != "Error: config path not found: does.not.exist\n" {
		t.Fatalf("missing get = code=%d stdout=%q stderr=%q", code, out, stderr)
	}
	if code, out, stderr := run([]string{"config", "get"}); code != 2 || out != "" || stderr != "Error: config path is required\n"+configUsage {
		t.Fatalf("no-path get = code=%d stdout=%q stderr=%q", code, out, stderr)
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

func TestCodexShimStatusIsNativeAndMatchesStateSummary(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	wrapper := filepath.Join(dir, "codex")
	backup := filepath.Join(dir, "codex.opencodex-original")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\n# opencodex codex autostart shim\nensure\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, []byte("original"), 0o700); err != nil {
		t.Fatal(err)
	}
	state := "{\"platform\":\"linux\",\"wrapperPath\":\"" + wrapper + "\",\"originalPath\":\"" + wrapper + "\",\"backupPath\":\"" + backup + "\"}"
	if err := os.WriteFile(filepath.Join(dir, "codex-shim.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("codex-shim status delegated"); return 0, nil }
	if got := Run([]string{"codex-shim", "status"}, deps); got != ExitOK {
		t.Fatalf("exit=%d stderr=%q", got, stderr.String())
	}
	want := "Codex autostart shim: wrapper shim present at " + wrapper + "; original backup present at " + backup + ".\n"
	if out.String() != want {
		t.Fatalf("stdout=%q want=%q", out.String(), want)
	}
}

func TestCodexShimMutationDelegates(t *testing.T) {
	var out, stderr bytes.Buffer
	var received []string
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func(args []string) (int, error) { received = append([]string(nil), args...); return 17, nil }
	if got := Run([]string{"codex-shim", "install"}, deps); got != 17 || !slices.Equal(received, []string{"codex-shim", "install"}) {
		t.Fatalf("mutation code=%d argv=%#v", got, received)
	}
}

func TestCodexShimStatusReportsCorruptStateWithoutFailing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENCODEX_HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, "codex-shim.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("codex-shim status delegated"); return 0, nil }
	if got := Run([]string{"codex-shim", "status"}, deps); got != ExitOK {
		t.Fatalf("exit=%d stderr=%q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "state is invalid or corrupt") {
		t.Fatalf("stdout=%q", out.String())
	}
}

func TestStatusEvidenceUsesRuntimeRecordAndPublicHealthzIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"service": "opencodex", "status": "ok", "version": "2.42.0", "uptime": 1.6, "pid": 4242,
		})
	}))
	defer server.Close()
	state := StatusRuntimeRecord{PID: 4242, Port: serverPort(strings.TrimPrefix(server.URL, "http://")), Hostname: "127.0.0.1"}
	probe := ProbeStatusEvidence(StatusProbeDeps{
		LoadConfig:  func() (*config.Config, error) { return &config.Config{Port: 9, Hostname: "0.0.0.0"}, nil },
		ReadRuntime: func() (StatusRuntimeRecord, error) { return state, nil },
	})
	if probe.Source != "runtime" || probe.Port != state.Port || probe.Runtime == nil {
		t.Fatalf("selection = %#v", probe)
	}
	if !probe.Health.OK || probe.Health.PID != 4242 || probe.Health.Message != "ok v2.42.0, uptime 2s" {
		t.Fatalf("health = %#v", probe.Health)
	}
}

func TestStatusEvidenceFallsBackToConfigAndRejectsForeignHealthz(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"service": "other", "status": "ok"})
	}))
	defer server.Close()
	port := serverPort(strings.TrimPrefix(server.URL, "http://"))
	probe := ProbeStatusEvidence(StatusProbeDeps{
		LoadConfig:  func() (*config.Config, error) { return &config.Config{Port: port, Hostname: "0.0.0.0"}, nil },
		ReadRuntime: func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
	})
	if probe.Source != "config" || probe.Runtime != nil || probe.Health.URL != fmt.Sprintf("http://127.0.0.1:%d/healthz", port) {
		t.Fatalf("probe = %#v", probe)
	}
	if probe.Health.OK || probe.Health.Message != "responded, but not an opencodex proxy" {
		t.Fatalf("health = %#v", probe.Health)
	}
}

func TestStatusEvidenceUsesTypeScriptHealthzMessageRules(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"service": "opencodex"})
	}))
	defer server.Close()
	port := serverPort(strings.TrimPrefix(server.URL, "http://"))
	probe := ProbeStatusEvidence(StatusProbeDeps{
		LoadConfig:  func() (*config.Config, error) { return &config.Config{Port: port}, nil },
		ReadRuntime: func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
	})
	if !probe.Health.OK || probe.Health.Message != "ok" {
		t.Fatalf("health = %#v", probe.Health)
	}
}

func TestStatusDomainsMatchTypeScriptOracleForConfigFallback(t *testing.T) {
	// The TypeScript command remains the owner, so its byte representation is
	// the contract for the diagnostic domains Go is incrementally porting.
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{\"port\":9,\"hostname\":\"0.0.0.0\"}"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("HOME", home)
	if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}

	oracle := runTypeScriptStatusJSON(t, home)
	want := statusDomainBytes(t, oracle)
	got, err := json.Marshal(CollectStatusDomains(StatusDomainDeps{
		ReadPID:        func() int64 { return 0 },
		ReadRuntime:    func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
		ReadBunRuntime: func() StatusBunRuntime { return statusOracleRuntime(t, oracle) },
		HTTPClient:     &http.Client{Timeout: 800 * time.Millisecond},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("domain bytes\\n got: %s\\nwant: %s", got, want)
	}
}

func TestStatusDomainsMatchTypeScriptOracleForDefaultAndMalformedConfig(t *testing.T) {
	for _, test := range []struct {
		name, content string
	}{
		{name: "default"},
		{name: "malformed", content: "{ invalid"},
		{name: "schema-invalid", content: "{\"port\":\"not-a-port\"}"},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			if test.content != "" {
				if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(test.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("OPENCODEX_HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
			t.Setenv("HOME", home)

			oracle := runTypeScriptStatusJSON(t, home)
			want := statusDomainBytes(t, oracle)
			got, err := json.Marshal(CollectStatusDomains(StatusDomainDeps{
				ReadPID:        func() int64 { return 0 },
				ReadRuntime:    func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
				ReadBunRuntime: func() StatusBunRuntime { return statusOracleRuntime(t, oracle) },
				HTTPClient:     &http.Client{Timeout: 800 * time.Millisecond},
			}))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Fatalf("domain bytes\\n got: %s\\nwant: %s", got, want)
			}
		})
	}
}

func TestStatusDomainsMatchTypeScriptOracleForDashboardPathRuntimeAndVersionSkew(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"port":4567,"hostname":"0.0.0.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	oracle := runTypeScriptStatusJSON(t, home)
	want := statusDomainBytes(t, oracle)
	got, err := json.Marshal(CollectStatusDomains(StatusDomainDeps{
		ReadPID:        func() int64 { return 0 },
		ReadRuntime:    func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
		ReadBunRuntime: func() StatusBunRuntime { return statusOracleRuntime(t, oracle) },
	}))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("domain bytes\n got: %s\nwant: %s", got, want)
	}
}

func TestStatusDomainsMatchTypeScriptOracleForAutostartAndConnection(t *testing.T) {
	for _, test := range []struct {
		name, content string
	}{
		{name: "autostart-disabled", content: `{"providers":{},"codexAutoStart":false}`},
		{name: "custom-default-provider", content: `{"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://api.example.test/v1","apiKey":"test-key"}},"defaultProvider":"fixture"}`},
		{name: "connected-client", content: `{"providers":{},"runtimeRole":"client","client":{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z"}}`},
		{name: "connected-client-future-catalog-age", content: `{"providers":{},"runtimeRole":"client","client":{"serverUrl":"https://hub.example.test","managementUrl":"https://manage.example.test","managementTransport":"direct","selectedClients":["codex"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"issued-key-id","tokenFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protocolVersion":1,"connectedAt":"2026-08-28T00:00:00.000Z","catalogSyncedAt":"2099-01-01T00:00:00.000Z"}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(test.content), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("HOME", home)
			t.Setenv("OPENCODEX_HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
			oracle := runTypeScriptStatusJSON(t, home)
			want := statusDomainBytes(t, oracle)
			got, err := json.Marshal(CollectStatusDomains(StatusDomainDeps{
				ReadPID:        func() int64 { return 0 },
				ReadRuntime:    func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
				ReadBunRuntime: func() StatusBunRuntime { return statusOracleRuntime(t, oracle) },
			}))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Fatalf("domain bytes\n got: %s\nwant: %s", got, want)
			}
		})
	}
}

func TestStatusDomainsMatchTypeScriptOracleForLiveVersionSkew(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"service": "opencodex", "version": "2.43.0", "uptime": 1, "pid": os.Getpid(),
		})
	}))
	defer server.Close()
	port := serverPort(strings.TrimPrefix(server.URL, "http://"))
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "codex"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "ocx.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	runtimeState, err := json.Marshal(StatusRuntimeRecord{PID: int64(os.Getpid()), Port: port, Hostname: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "runtime-port.json"), runtimeState, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	oracle := runTypeScriptStatusJSON(t, home)
	want := statusDomainBytes(t, oracle)
	got, err := json.Marshal(CollectStatusDomains(StatusDomainDeps{
		ReadPID: func() int64 { return int64(os.Getpid()) },
		ReadRuntime: func() (StatusRuntimeRecord, error) {
			return StatusRuntimeRecord{PID: int64(os.Getpid()), Port: port, Hostname: "127.0.0.1"}, nil
		},
		ReadBunRuntime: func() StatusBunRuntime { return statusOracleRuntime(t, oracle) },
		CLIVersion:     "2.42.0",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("domain bytes\n got: %s\nwant: %s", got, want)
	}
}

func TestComputeStatusVersionSkewMatchesTypeScriptContract(t *testing.T) {
	for _, test := range []struct {
		cli, proxy string
		want       bool
	}{
		{cli: "2.42.0", proxy: "", want: false},
		{cli: "unknown", proxy: "2.43.0", want: false},
		{cli: "2.42.0", proxy: "0.0.0", want: false},
		{cli: "2.42.0", proxy: "2.42.0", want: false},
		{cli: "2.42.0", proxy: "2.43.0", want: true},
	} {
		got := ComputeStatusVersionSkew(test.cli, test.proxy)
		if got.Skewed != test.want {
			t.Fatalf("ComputeStatusVersionSkew(%q, %q) = %#v", test.cli, test.proxy, got)
		}
	}
}

func TestDoctorProxyDownHintMatchesTypeScriptOracle(t *testing.T) {
	for _, input := range []DoctorProxyDownInput{
		{ProxyRunning: true, Port: 10100},
		{Port: 10100},
		{Port: 12000, ServiceViable: true},
		{Port: 10100, ServiceInstalled: true},
		{Port: 10100, ServiceInstalled: true, ServiceConflict: true, StaleProcessState: true},
	} {
		want := runTypeScriptDoctorProxyHint(t, input)
		if got := DoctorProxyDownRestartHint(input); got != want {
			t.Fatalf("doctor hint\\n got: %q\\nwant: %q", got, want)
		}
	}
}

func TestStatusEvidenceAcceptsAnySuccessfulHealthzStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"service": "opencodex"})
	}))
	defer server.Close()
	port := serverPort(strings.TrimPrefix(server.URL, "http://"))
	probe := ProbeStatusEvidence(StatusProbeDeps{
		LoadConfig:  func() (*config.Config, error) { return &config.Config{Port: port}, nil },
		ReadRuntime: func() (StatusRuntimeRecord, error) { return StatusRuntimeRecord{}, errors.New("missing") },
	})
	if !probe.Health.OK || probe.Health.Message != "ok" {
		t.Fatalf("health = %#v", probe.Health)
	}
}

func TestDelegatedFamilyHelpUsesOwnerOutput(t *testing.T) {
	for _, command := range []string{"doctor", "service"} {
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
