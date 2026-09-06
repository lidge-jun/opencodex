package ocxcli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// TestDoctorCommandAssemblyMatchesTypeScriptOracle compares the complete
// native report assembly to a real TypeScript doctor invocation one section at
// a time. The rows called out below are the only rows with native probes; all
// including the portable OAuth/catalog/hints tail.
func TestDoctorCommandAssemblyMatchesTypeScriptOracle(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{\"proxy\":\"$DOCTOR_PROXY\",\"providers\":{\"missing\":{\"adapter\":\"openai-chat\",\"baseUrl\":\"https://example.test/v1\",\"authMode\":\"key\",\"apiKey\":\"$DOCTOR_KEY\",\"defaultModel\":\"m\"}},\"defaultProvider\":\"missing\"}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model_provider = \"opencodex\"\n\n[model_providers.opencodex]\nenv_key = \"OPENCODEX_API_AUTH_TOKEN\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(home, "responses-state.json.ocx.999999.1.tmp")
	if err := os.WriteFile(temp, make([]byte, 2*1024*1024), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-16 * time.Minute)
	if err := os.Chtimes(temp, old, old); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("DOCTOR_PROXY", "")
	t.Setenv("DOCTOR_KEY", "")
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"} {
		t.Setenv(key, "")
	}

	oracle, exitCode := runTypeScriptDoctor(t, home, codexHome)
	if exitCode != ExitOK {
		t.Fatalf("TypeScript doctor exit = %d; output=%s", exitCode, oracle)
	}
	result := AssembleDoctorCommand(nil, DoctorCommandDeps{})
	if result.Exit != ExitOK {
		t.Fatalf("native assembly exit = %d; output=%s", result.Exit, result.Text)
	}
	for _, section := range []struct{ heading, next string }{
		{"Paths", "Response-state temp files"},
		{"Response-state temp files", "Codex app home targeting"},
		{"Codex app home targeting", "Codex restart safety"},
		{"Codex restart safety", "Codex runtime selection"},
		{"Codex runtime selection", "Current doctor process proxy env (presence only)"},
		{"Current doctor process proxy env (presence only)", "Configured proxy (value hidden)"},
		{"Configured proxy (value hidden)", "Provider API keys (value hidden)"},
		{"Provider API keys (value hidden)", "Codex env_key launch readiness"},
		{"Codex env_key launch readiness", "Running proxy process proxy env (presence only)"},
		{"Running proxy process proxy env (presence only)", "Memory / runtime"},
		{"Memory / runtime", "WHAM reachability"},
		{"Codex history metadata restore", "Codex native-write coordinator"},
		{"Project Codex configs", "Codex agent role files"},
	} {
		got := doctorSection(result.Text, section.heading, section.next)
		want := doctorSection(oracle, section.heading, section.next)
		if got != want {
			t.Fatalf("%s differs from TypeScript oracle\nGo: %q\nTypeScript: %q", section.heading, got, want)
		}
	}
	gotTail := doctorSection(result.Text, "OAuth reliability", "Hints")
	wantTail := doctorSection(oracle, "OAuth reliability", "Hints")
	if strings.ReplaceAll(gotTail, "\n\n  [WARN] Codex app-server", "\n  [WARN] Codex app-server") != wantTail {
		t.Fatalf("OAuth/catalog tail differs from TypeScript oracle\nGo: %q\nTypeScript: %q", gotTail, wantTail)
	}
}

func TestDoctorCommandCoordinatorAndOAuthFailureAssembly(t *testing.T) {
	deps := DoctorCommandDeps{
		Coordinator: func() DoctorCoordinatorDiagnostic {
			return DoctorCoordinatorDiagnostic{Kind: "zero-byte", Path: "/tmp/coordinator.sqlite", Size: 0, Version: 0, Tables: nil, TransitionRows: ptr(0), SingletonRows: ptr(0)}
		},
		OAuth:     func() []DoctorOAuthCheck { return []DoctorOAuthCheck{{Level: "FAIL", Message: "collision"}} },
		OAuthLive: func() (DoctorOAuthHealthSource, []DoctorOAuthAccount) { return DoctorOAuthUnavailable, nil },
		Catalog:   func() DoctorCatalogState { return DoctorCatalogState{State: "fresh"} },
		Hints:     func(DoctorHintsInput) []string { return []string{"hint"} },
	}
	result := AssembleDoctorCommand(nil, deps)
	if result.Exit != ExitFailure {
		t.Fatalf("exit=%d, want failure", result.Exit)
	}
	for _, want := range []string{
		"Codex native-write coordinator\n  !!     native-write coordinator is a zero-byte remnant and has no authority",
		"Action: stop the OpenCodex proxy/service, then run ocx doctor --recover-zero-byte-coordinator --yes",
		"OAuth reliability\n  [FAIL] collision",
		"[OK] Codex app-server model catalog is current with the on-disk catalog.",
		"Hints\n  - hint",
	} {
		if !strings.Contains(result.Text, want) {
			t.Fatalf("missing %q in %q", want, result.Text)
		}
	}
}

func ptr(value int) *int { return &value }

func TestDoctorCommandAssemblyUsesPortableProbe3Sections(t *testing.T) {
	deps := DoctorCommandDeps{
		Paths: func() []DoctorPathRow { return nil }, Mounts: func() string { return "" },
		ResponseTemps:    func(bool) DoctorResponseTempResult { return DoctorResponseTempResult{} },
		Env:              func() map[string]string { return map[string]string{} },
		Config:           func() StatusConfigDiagnostic { return StatusConfigDiagnostic{Source: "default"} },
		OrderedProviders: func() *config.OrderedValue { return nil }, CodexConfigText: func() string { return "" },
		ServiceToken: func() bool { return false }, Shim: func() DoctorShimDiagnostic { return DoctorShimDiagnostic{} },
		RunningProxyEnv: func() DoctorRunningProxyEnv { return DoctorRunningProxyEnv{Status: "not_running"} },
		OrcaHome:        func() DoctorOrcaHome { return DoctorOrcaHome{EffectiveCodexHome: "/codex"} },
		RestartSafety: func() DoctorRestartSafety {
			return DoctorRestartSafety{RebootSafe: true, Summary: "native Codex routing (no opencodex restart dependency)", Detail: "routing=native, service=not installed, shim=not installed"}
		},
		RuntimeSelection: func() DoctorRuntimeSelection { return DoctorRuntimeSelection{Path: "codex", Source: "fallback"} },
		WHAM: func() DoctorWhamResult {
			return DoctorWhamResult{OK: true, Classification: "ok", Duration: 12 * time.Millisecond}
		},
		AgentRoles: func() []string { return []string{"reviewer"} },
		WSL: func() DoctorWslDiagnostic {
			return DoctorWslDiagnostic{WSL: true, EffectiveCodexHome: "/home/a/.codex"}
		},
		BunVersion:       func() string { return "1.3.14" },
		Memory:           func() DoctorServiceMemoryReport { return DoctorServiceMemoryReport{Status: "not_running"} },
		History:          func() DoctorHistoryPending { return DoctorHistoryPending{} },
		HistoryNamespace: func() DoctorHistoryState { return DoctorHistoryState{Namespace: "missing"} },
		ProjectConfigs:   func() []DoctorProjectConfigWarning { return nil },
	}
	got := AssembleDoctorCommand(nil, deps).Text
	for _, want := range []string{
		"Codex app home targeting\n  ok  Effective Codex home: /codex",
		"Codex restart safety\n  ok  native Codex routing (no opencodex restart dependency)",
		"Codex runtime selection\n  ok  Selected runtime: codex (unknown, source=fallback)",
		"WHAM reachability\n  ok https://chatgpt.com/backend-api/wham/usage\n       error=ok, 12ms, unauthenticated",
		"Codex agent role files\n  [WARN] 1 agent role file contains `model_fallback`: reviewer",
		"WSL Codex installs\n  -- Linux ~/.codex/config.toml",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("report missing %q in %q", want, got)
		}
	}
	deps.WSL = func() DoctorWslDiagnostic { return DoctorWslDiagnostic{} }
	if got := AssembleDoctorCommand(nil, deps).Text; strings.Contains(got, "WSL Codex installs") {
		t.Fatalf("non-WSL report included an empty WSL section: %q", got)
	}
}

func TestDoctorCommandAssemblyArgumentsAndTODOBoundary(t *testing.T) {
	var reclamations []bool
	deps := DoctorCommandDeps{
		Paths:  func() []DoctorPathRow { return []DoctorPathRow{{Label: "CODEX_HOME", Path: "/codex"}} },
		Mounts: func() string { return "" },
		ResponseTemps: func(reclaim bool) DoctorResponseTempResult {
			reclamations = append(reclamations, reclaim)
			return DoctorResponseTempResult{}
		},
		Env:              func() map[string]string { return map[string]string{} },
		Config:           func() StatusConfigDiagnostic { return StatusConfigDiagnostic{Source: "default"} },
		OrderedProviders: func() *config.OrderedValue { return nil },
		CodexConfigText:  func() string { return "" },
		ServiceToken:     func() bool { return false },
		Shim:             func() DoctorShimDiagnostic { return DoctorShimDiagnostic{} },
		RunningProxyEnv:  func() DoctorRunningProxyEnv { return DoctorRunningProxyEnv{Status: "not_running"} },
		OrcaHome:         func() DoctorOrcaHome { return DoctorOrcaHome{} },
		RestartSafety:    func() DoctorRestartSafety { return DoctorRestartSafety{} },
		RuntimeSelection: func() DoctorRuntimeSelection { return DoctorRuntimeSelection{} },
		WHAM:             func() DoctorWhamResult { return DoctorWhamResult{} },
		AgentRoles:       func() []string { return nil },
		WSL:              func() DoctorWslDiagnostic { return DoctorWslDiagnostic{} },
		BunVersion:       func() string { return "1.3.14" },
		Memory:           func() DoctorServiceMemoryReport { return DoctorServiceMemoryReport{Status: "not_running"} },
		History:          func() DoctorHistoryPending { return DoctorHistoryPending{} },
		HistoryNamespace: func() DoctorHistoryState { return DoctorHistoryState{Namespace: "missing"} },
		ProjectConfigs:   func() []DoctorProjectConfigWarning { return nil },
		ProxyDownHint:    func() string { return "hint" },
	}
	result := AssembleDoctorCommand([]string{"--reclaim-response-tempz", "--reclaim-response-temps"}, deps)
	if result.Exit != ExitOK || len(reclamations) != 1 || !reclamations[0] {
		t.Fatalf("reclaim result = %#v, calls=%#v", result, reclamations)
	}
	if !strings.Contains(result.Text, "Unrecognized flag --reclaim-response-tempz; did you mean --reclaim-response-temps? Reporting only.") || !strings.Contains(result.Text, "Hints\n  - hint") {
		t.Fatalf("argument output = %q", result.Text)
	}
	var output bytes.Buffer
	if code := RunDoctorCommand([]string{"--recover-zero-byte-coordinator"}, &output, &output, deps); code != ExitFailure {
		t.Fatalf("recovery confirmation exit = %d", code)
	}
	if output.String() != "Recovery is explicit and creates a same-directory backup. Re-run: ocx doctor --recover-zero-byte-coordinator --yes\n" {
		t.Fatalf("recovery confirmation = %q", output.String())
	}
	// The command dispatcher owns this rejection today. Keep the future native
	// boundary byte-identical to its real TypeScript oracle before doctor moves.
	tsJSON, tsJSONExit := runTypeScriptDoctorArgs(t, t.TempDir(), t.TempDir(), "--json=true")
	if tsJSONExit != doctorJSONExit || tsJSON != doctorJSONUsage {
		t.Fatalf("TypeScript --json=true = exit %d, output %q; want exit %d, output %q", tsJSONExit, tsJSON, doctorJSONExit, doctorJSONUsage)
	}
	for _, arg := range []string{"--json", "--json=true", "-json", "——json"} {
		var stdout, stderr bytes.Buffer
		if code := RunDoctorCommand([]string{arg}, &stdout, &stderr, deps); code != doctorJSONExit {
			t.Fatalf("%q exit = %d, want usage", arg, code)
		}
		if stdout.Len() != 0 || stderr.String() != doctorJSONUsage {
			t.Fatalf("%q output stdout=%q stderr=%q", arg, stdout.String(), stderr.String())
		}
	}
}
