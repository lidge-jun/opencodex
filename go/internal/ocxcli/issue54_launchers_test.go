package ocxcli

// Hermetic unit tests for the issue #54 launcher + ops slice: gui/zcode/mcode/mmx.
// Everything here stays off the spawn/live-proxy path — argument classification,
// loopback gates, usage rejections, and message text — so the byte contract is
// pinned in-process and the differential harness covers the live lanes.

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestLauncherArgumentClassification(t *testing.T) {
	cases := []struct {
		client string
		args   []string
		want   bool
	}{
		{"mcode", []string{"--help"}, true},
		{"mcode", []string{"-h"}, true},
		{"mcode", []string{"--version"}, true},
		{"mcode", []string{"-v"}, true},
		{"mcode", []string{"-V"}, true},
		{"mcode", []string{"--version", "extra"}, false},
		{"mmx", []string{"--help"}, true},
		{"mmx", []string{"--version"}, true},
		{"mmx", []string{"-v"}, true},
		{"mmx", []string{"-V"}, false}, // MMX 1.0.19 has -v only
		{"mmx", []string{"text", "chat", "--message", "-v"}, false},
	}
	for _, tc := range cases {
		if got := standaloneInformational(tc.args, tc.client); got != tc.want {
			t.Errorf("standaloneInformational(%v, %s) = %t, want %t", tc.args, tc.client, got, tc.want)
		}
	}
}

func TestMmxCommandPathScanner(t *testing.T) {
	cases := []struct {
		argv []string
		want []string
	}{
		{[]string{"--output", "json", "text", "chat", "--message", "hello"}, []string{"text", "chat"}},
		{[]string{"--help=false", "text", "chat"}, []string{"text", "chat"}},
		{[]string{"--yes", "text", "chat", "--message", "hello"}, []string{"text", "chat"}},
		{[]string{"--stream", "text", "chat", "--message", "hello"}, []string{"text", "chat"}},
		{[]string{"text", "repl", "--verbose"}, []string{"text", "repl"}},
		{[]string{"image", "generate", "--prompt", "cat"}, []string{"image", "generate"}},
		{[]string{"--", "text"}, nil},
	}
	for _, tc := range cases {
		if got := mmxCommandPath(tc.argv); !slices.Equal(got, tc.want) {
			t.Errorf("mmxCommandPath(%v) = %v, want %v", tc.argv, got, tc.want)
		}
	}
}

func TestMmxUnsafeOverride(t *testing.T) {
	for _, argv := range [][]string{
		{"text", "chat", "--api-key", "hidden"},
		{"--base-url=https://example.test", "text", "chat"},
		{"--region", "cn", "text", "chat"},
		{"text", "chat", "--region=cn"},
	} {
		if got := mmxUnsafeOverride(argv); got == "" {
			t.Errorf("mmxUnsafeOverride(%v) = none, want a flag name", argv)
		}
	}
	if got := mmxUnsafeOverride([]string{"text", "chat", "--model", "mock/model"}); got != "" {
		t.Errorf("mmxUnsafeOverride(model) = %q, want none", got)
	}
}

func TestIsLoopbackHostname(t *testing.T) {
	loopback := []string{"", "localhost", "127.0.0.1", "::1", "[::1]", "LOCALHOST.", " 127.0.0.1 "}
	remote := []string{"0.0.0.0", "10.0.0.1", "example.test", "[::2]"}
	for _, value := range loopback {
		if !isLoopbackHostname(value) {
			t.Errorf("isLoopbackHostname(%q) = false, want true", value)
		}
	}
	for _, value := range remote {
		if isLoopbackHostname(value) {
			t.Errorf("isLoopbackHostname(%q) = true, want false", value)
		}
	}
}

func TestMcodeYamlBaseURL(t *testing.T) {
	flow := "{custom_provider: {opencodex: {models: {m1: {}, m2: {}}, options: {baseURL: http://127.0.0.1:10100,apiKey: opencodex-loopback}}}}\n"
	if got := mcodeOpenCodexBaseURL(flow); got != "http://127.0.0.1:10100" {
		t.Fatalf("flow baseURL = %q", got)
	}
	if got := mcodeOpenCodexBaseURL("not: [valid"); got != "" {
		t.Fatalf("invalid flow = %q, want empty", got)
	}
	if got := mcodeOpenCodexBaseURL("{custom_provider: {opencodex: {options: {}}}}"); got != "" {
		t.Fatalf("missing baseURL = %q, want empty", got)
	}
}

// launcherGateConfig writes a complete config so the TS loader would not repair
// it; the non-loopback hostname stops the launcher before any proxy discovery.
func launcherGateConfig(t *testing.T, home string, hostname string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{
  "hostname": "`+hostname+`",
  "port": 1,
  "providers": {"fixture": {"adapter": "openai-chat", "baseUrl": "https://example.test/v1", "apiKey": "k"}},
  "defaultProvider": "fixture"
}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLauncherLoopbackGates(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	launcherGateConfig(t, home, "10.0.0.1")
	var out, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &stderr}
	deps.Delegate = func([]string) (int, error) { t.Fatal("delegated"); return 0, nil }
	if code := Run([]string{"mcode"}, deps); code != 2 {
		t.Fatalf("mcode = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "❌ MiniMax Code integration is loopback-only") {
		t.Fatalf("mcode stderr = %q", stderr.String())
	}
	stderr.Reset()
	if code := Run([]string{"mmx", "text", "chat"}, deps); code != 2 {
		t.Fatalf("mmx = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "❌ ocx mmx is loopback-only") {
		t.Fatalf("mmx stderr = %q", stderr.String())
	}
}

func TestMmxArgumentRejections(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	var out, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &stderr}
	if code := Run([]string{"mmx", "text", "chat", "--api-key", "hidden"}, deps); code != 2 {
		t.Fatalf("mmx unsafe = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "--api-key is not accepted by ocx mmx") {
		t.Fatalf("mmx unsafe stderr = %q", stderr.String())
	}
	stderr.Reset()
	if code := Run([]string{"mmx", "image", "generate", "--prompt", "cat"}, deps); code != 2 {
		t.Fatalf("mmx surface = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "❌ ocx mmx supports only `mmx text` commands") {
		t.Fatalf("mmx surface stderr = %q", stderr.String())
	}
}

func TestZcodeUsageRejections(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	var out, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &stderr}
	deps.Delegate = func([]string) (int, error) { t.Fatal("delegated"); return 0, nil }
	if code := Run([]string{"zcode", "bogus"}, deps); code != 2 {
		t.Fatalf("zcode bogus = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "unknown zcode command bogus") || !strings.Contains(stderr.String(), "ocx zcode restore --op <opId>") {
		t.Fatalf("zcode bogus stderr = %q", stderr.String())
	}
	if !strings.HasSuffix(stderr.String(), "\n") {
		t.Fatalf("zcode usage must end with a newline: %q", stderr.String())
	}
	stderr.Reset()
	if code := Run([]string{"zcode", "restore"}, deps); code != 2 {
		t.Fatalf("zcode restore = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Error: --op <opId> is required") {
		t.Fatalf("zcode restore stderr = %q", stderr.String())
	}
}

func TestZcodeWithoutRuntimeReportsStartHint(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	launcherGateConfig(t, home, "10.0.0.1")
	var out, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &stderr}
	if code := Run([]string{"zcode", "status"}, deps); code != 1 {
		t.Fatalf("zcode status = %d, stderr=%q", code, stderr.String())
	}
	if strings.TrimSpace(stderr.String()) != "Error: Proxy is not running. Start it with: ocx start" {
		t.Fatalf("zcode status stderr = %q", stderr.String())
	}
}

func TestGuiPairingUsageRejections(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	launcherGateConfig(t, home, "10.0.0.1")
	var out, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &stderr}
	for _, argv := range [][]string{
		{"gui", "pair"},
		{"gui", "pair", "--origin"},
		{"gui", "pair", "--origin", "--json"},
		{"gui", "not-a-sub"},
	} {
		if code := Run(argv, deps); code != ExitFailure {
			t.Fatalf("%v = %d, stderr=%q", argv, code, stderr.String())
		}
		if !strings.Contains(stderr.String(), "Usage: ocx gui [pair --origin <browser-origin> [--json]]") {
			t.Fatalf("%v stderr = %q", argv, stderr.String())
		}
		stderr.Reset()
	}
}

func TestGuiPairingOriginGate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	launcherGateConfig(t, home, "10.0.0.1")
	var out, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &stderr}
	code := Run([]string{"gui", "pair", "--origin", "http://dash.example.test"}, deps)
	if code != ExitFailure {
		t.Fatalf("pair gate = %d, stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "The pairing origin is not enabled by hub.managementPublicOrigin or corsAllowOrigins.") {
		t.Fatalf("pair gate stderr = %q", stderr.String())
	}
}
