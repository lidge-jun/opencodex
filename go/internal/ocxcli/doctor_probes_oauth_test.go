package ocxcli

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDoctorOAuthReliabilityMatchesTypeScriptOracle(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "codex"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("OPENCODEX_API_AUTH_TOKEN", "  data-plane  ")
	if err := os.WriteFile(filepath.Join(home, "admin-api-token"), []byte("ocx_admin_"+strings.Repeat("a", 43)), 0600); err != nil {
		t.Fatal(err)
	}
	repo := typeScriptOracleRepo(t)
	bun := "/home/ubuntu/.local/share/mise/installs/bun/latest/bin/bun"
	script := "import { collectOAuthDoctorChecks } from './src/cli/doctor'; process.stdout.write(JSON.stringify((await collectOAuthDoctorChecks()).slice(0,3)));"
	cmd := exec.Command(bun, "-e", script)
	// The worktree may not carry node_modules; the oracle helper locates a
	// checkout that does. Run there while retaining this isolated HOME.
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "HOME="+home, "OPENCODEX_HOME="+home, "CODEX_HOME="+filepath.Join(home, "codex"), "OPENCODEX_API_AUTH_TOKEN=  data-plane  ")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript OAuth oracle: %v: %s", err, out)
	}
	var want []DoctorOAuthCheck
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("decode oracle: %v: %s", err, out)
	}
	got := CollectDoctorOAuthReliabilityDefault()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("OAuth checks\\n got: %#v\\nwant: %#v", got, want)
	}
}

func TestDoctorOAuthCollisionAndNoSecret(t *testing.T) {
	secret := "ocx_admin_" + strings.Repeat("z", 43)
	checks := CollectDoctorOAuthReliability(DoctorOAuthReliabilityInput{DataPlaneToken: secret, CredentialDirectory: t.TempDir(), RefreshLockPath: filepath.Join(t.TempDir(), "auth.refresh.x.lock")})
	if checks[0].Level != "FAIL" || strings.Contains(checks[0].Message, secret) {
		t.Fatalf("collision=%#v", checks[0])
	}
	if got := CollectDoctorOAuthReliability(DoctorOAuthReliabilityInput{DataPlaneToken: " ", ServiceToken: "different", AdminToken: "admin", CredentialDirectory: t.TempDir(), RefreshLockPath: filepath.Join(t.TempDir(), "auth.refresh.x.lock")}); got[0].Message != "Data-plane and management credentials are distinct." {
		t.Fatalf("service fallback=%#v", got[0])
	}
}

func TestDoctorCatalogLiveCollector(t *testing.T) {
	mtime := time.Unix(100, 0)
	equal := mtime
	collector := DoctorCatalogCollector{
		List: func() ([]DoctorAppServerProcess, error) {
			return []DoctorAppServerProcess{{PID: 7, CommandLine: "codex app-server"}, {PID: 7, CommandLine: "codex app-server"}, {PID: 9, CommandLine: "codex -- app-server"}}, nil
		},
		StartedAt: func(pid int) (*time.Time, error) {
			if pid == 7 {
				return &equal, nil
			}
			return nil, nil
		},
		CatalogMtime: func() (*time.Time, error) { return &mtime, nil },
	}
	if got := CollectDoctorCatalogStateLive(collector); got.State != "stale" || !reflect.DeepEqual(got.PIDs, []int{7}) {
		t.Fatalf("catalog=%#v", got)
	}
	failed := collector
	failed.List = func() ([]DoctorAppServerProcess, error) { return nil, errors.New("denied") }
	if got := CollectDoctorCatalogStateLive(failed); got.State != "unknown" {
		t.Fatalf("enumeration=%#v", got)
	}
}

func TestDoctorCatalogCommandMatcher(t *testing.T) {
	for _, input := range []struct {
		command, executable string
		want                bool
	}{
		{"codex app-server", "codex", true}, {"node /bin/codex app-server", "node", true}, {"codex --config a.toml app-server", "codex", true}, {"codex-x86_64-pc-linux-musl app-server", "codex-x86_64-pc-linux-musl", true}, {"codex -- app-server", "codex", false}, {"hermes-codex-bridge-mcp app-server", "hermes-codex-bridge-mcp", false}, {"codex exec app-server", "codex", false}, {"codex-code-mode-host", "codex-code-mode-host", true},
	} {
		if got := doctorIsCodexAppServer(input.command, input.executable); got != input.want {
			t.Errorf("%q=%v want %v", input.command, got, input.want)
		}
	}
}

func TestDoctorHintsOrderAndPrecedence(t *testing.T) {
	got := CollectDoctorHints(DoctorHintsInput{ProxyDown: "proxy", ProviderKeyDetails: []string{"key-a", "key-b"}, CodexEnvKeyDetail: "env", CodexEnvKeyAction: "act", RebootSafe: true, ProbeOK: false, NoProxy: true, ProbeClassification: "timeout", PendingFailed: true, PendingFailureReason: "busy", DualInstall: true, AutomountRoot: "/mnt", InteropCodexPath: "codex.exe"})
	want := []string{"proxy", "key-a", "key-b", "env. act.", "WHAM probe could not reach chatgpt.com. On WSL2 this is often NAT/DNS/VPN. Quota cannot prime, so auto-switch stays on unknown scores.", "No proxy is visible to this doctor process and config.proxy is unset or unresolved. If Windows uses a proxy/VPN, set config.proxy or start ocx from a shell with HTTP(S)_PROXY.", "Backed-up history metadata is pending or its state is unreadable. The running proxy retries exact restoration automatically; to force it now, close the Codex app and run 'ocx sync'. Untracked routed history is not relabeled."}
	if !reflect.DeepEqual(got[:len(want)], want) {
		t.Fatalf("hints\\n got: %#v\\nwant prefix: %#v", got, want)
	}
}
