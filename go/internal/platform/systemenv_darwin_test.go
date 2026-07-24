//go:build darwin

package platform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSystemEnvHookInjectionAndReversion(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, ".zshrc")
	original := "export KEEP_ME=yes\n"
	if err := os.WriteFile(profile, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installShellHook(profile); err != nil {
		t.Fatal(err)
	}
	if err := installShellHook(profile); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(installed), systemEnvBegin) != 1 || !strings.Contains(string(installed), original) {
		t.Fatalf("installed profile = %q", installed)
	}
	if err := uninstallShellHook(profile); err != nil {
		t.Fatal(err)
	}
	reverted, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if string(reverted) != original {
		t.Fatalf("reverted profile = %q, want %q", reverted, original)
	}
}

func TestWriteSystemEnvFileQuotesValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".opencodex", "system-env.sh")
	if err := writeSystemEnvFile(path, map[string]string{"OPENCODEX_PROXY_URL": "http://127.0.0.1:10100", "WITH_QUOTE": "a'b"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `export WITH_QUOTE='a'\''b'`) {
		t.Fatalf("env file = %q", data)
	}
}
