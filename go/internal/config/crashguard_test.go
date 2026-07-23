package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCrashGuardRecoversAndRedacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "crash.log")
	panicked := func() (returned bool) {
		defer func() { returned = true }()
		defer InstallCrashGuard(path)()
		panic("Bearer abcdefghijklmnop")
	}()
	if !panicked {
		t.Fatal("guarded function did not return after panic recovery")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	entry := string(data)
	if strings.Contains(entry, "abcdefghijklmnop") || !strings.Contains(entry, RedactedSecret) {
		t.Fatalf("crash entry was not redacted: %q", entry)
	}
}
