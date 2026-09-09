package ocxcli

// Unit tests for the runClaude gate order and message bytes. The live-local
// ensure/spawn path and the cache/agents write lanes are exercised end-to-end
// by the claude parity describe in tests/go-cli-parity.test.ts.

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func claudeTestDeps() (Deps, *bytes.Buffer) {
	var out bytes.Buffer
	deps := Deps{
		Stdout: &out,
		Stderr: &out,
		ReadRuntime: func() (RuntimeState, error) {
			return RuntimeState{}, errors.New("no runtime record in tests")
		},
	}
	return deps, &out
}

// claudeStageHome writes config.json + optional service token under a temp
// home and neutralizes the ambient env the dev shell may carry.
func claudeStageHome(t *testing.T, config string, token string) {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if token != "" {
		if err := os.WriteFile(filepath.Join(home, "service-api-token"), []byte(token), 0o600); err != nil {
			t.Fatalf("write token: %v", err)
		}
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	codex := filepath.Join(home, "codex")
	if err := os.MkdirAll(codex, 0o700); err != nil {
		t.Fatalf("mkdir codex: %v", err)
	}
	t.Setenv("CODEX_HOME", codex)
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "")
	t.Setenv("OPENCODEX_ADMIN_AUTH_TOKEN", "")
	t.Setenv("OCX_API_TOKEN_FILE", "")
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_BASE_URL", "")
	// claude must not resolve: point PATH at an empty dir so the spawn lane
	// fails with ENOENT (asserted in the connected-ok test).
	t.Setenv("PATH", t.TempDir())
}

const claudeConnectedBlock = `"client":{"serverUrl":"http://127.0.0.1:1","managementUrl":"http://127.0.0.1:1","managementTransport":"direct","selectedClients":["claude"],"tokenEnv":"OPENCODEX_API_AUTH_TOKEN","apiKeyId":"k1","tokenFingerprint":"%s","protocolVersion":1,"connectedAt":"2026-09-09T00:00:00.000Z"}`

func claudeConnectedConfig(token string, selected ...string) string {
	if len(selected) == 0 {
		selected = []string{"claude"}
	}
	block := strings.ReplaceAll(claudeConnectedBlock, "%s", sha256Hex(token))
	block = strings.Replace(block, `"selectedClients":["claude"]`, `"selectedClients":[`+strings.Join(quoteJSON(selected), ",")+`]`, 1)
	return `{"runtimeRole":"client","client":` + strings.TrimPrefix(block, `"client":`) + `}`
}

func TestClaudeCommandGates(t *testing.T) {
	token := "svc-tok-abcdef"

	cases := []struct {
		name    string
		config  string
		token   string
		wantOut string
	}{
		{
			name:    "disabled gate",
			config:  `{"claudeCode":{"enabled":false}}`,
			wantOut: "Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config).\n",
		},
		{
			name:    "invalid role",
			config:  `{"runtimeRole":"weird"}`,
			wantOut: "Client state is invalid: config.json.runtimeRole is invalid\n",
		},
		{
			name:    "client present without role",
			config:  `{"client":{"apiKeyId":"k"}}`,
			wantOut: "Client state is mismatched: config.json.client is present without runtimeRole=client\n",
		},
		{
			name:    "role client without client",
			config:  `{"runtimeRole":"client"}`,
			wantOut: "Client state is mismatched: runtimeRole=client is present without config.json.client\n",
		},
		{
			name:    "claude not selected",
			config:  claudeConnectedConfig(token, "codex"),
			token:   token,
			wantOut: "Claude is not selected for this remote hub connection.\n",
		},
		{
			name:    "connected token missing",
			config:  claudeConnectedConfig(token),
			wantOut: "Connected service token is missing.\n",
		},
		{
			name:    "connected token ownership changed",
			config:  claudeConnectedConfig(token),
			token:   "other-token",
			wantOut: "Connected service token ownership changed.\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claudeStageHome(t, tc.config, tc.token)
			deps, out := claudeTestDeps()
			code := runClaude([]string{}, deps)
			if code != ExitFailure {
				t.Fatalf("exit = %d, want %d (out: %s)", code, ExitFailure, out.String())
			}
			if out.String() != tc.wantOut {
				t.Fatalf("output mismatch:\n got: %q\nwant: %q", out.String(), tc.wantOut)
			}
		})
	}
}

func quoteJSON(values []string) []string {
	out := make([]string, len(values))
	for i, value := range values {
		raw, _ := json.Marshal(value)
		out[i] = string(raw)
	}
	return out
}

func TestClaudeCommandConnectedSpawnENOENT(t *testing.T) {
	token := "svc-tok-abcdef"
	claudeStageHome(t, claudeConnectedConfig(token), token)
	deps, out := claudeTestDeps()
	code := runClaude([]string{}, deps)
	if code != ExitFailure {
		t.Fatalf("exit = %d, want 1 (out: %s)", code, out.String())
	}
	text := out.String()
	// The connected flow refreshes the gateway cache against the (unreachable)
	// target, then attempts the spawn and fails with the ENOENT install hint.
	if !strings.Contains(text, claudeCacheWarnStatic) {
		t.Fatalf("missing gateway-cache warning; out: %s", text)
	}
	if !strings.Contains(text, "❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code") {
		t.Fatalf("missing ENOENT hint; out: %s", text)
	}
	if strings.Index(text, claudeCacheWarnStatic) > strings.Index(text, "CLI not found") {
		t.Fatalf("warning ordering wrong; out: %s", text)
	}
}
