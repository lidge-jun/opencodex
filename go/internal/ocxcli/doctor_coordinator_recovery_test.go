package ocxcli

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func coordinatorFixture(t *testing.T, bytes []byte) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows recovery oracle is exempt pending SID/reparse identity parity")
	}
	home := t.TempDir()
	codexHome := filepath.Join(home, "codex")
	if err := os.Mkdir(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", codexHome)
	root := filepath.Join("/tmp", "opencodex-runtime-v1-"+fmt.Sprint(os.Getuid()), "native-write-locks")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	real, err := filepath.EvalSymlinks(codexHome)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(real))
	path := filepath.Join(root, fmt.Sprintf("%x.sqlite", digest))
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Remove(path)
		matches, _ := filepath.Glob(path + ".zero-byte-backup-*")
		for _, match := range matches {
			_ = os.Remove(match)
		}
	})
	return path
}

func TestRecoverZeroByteCoordinatorMovesExactFixture(t *testing.T) {
	path := coordinatorFixture(t, nil)
	backup, err := RecoverZeroByteCodexCoordinator(time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	want := path + ".zero-byte-backup-20260821T120000.000Z"
	if backup != want {
		t.Fatalf("backup = %q, want %q", backup, want)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("source remained: %v", err)
	}
	got, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "" {
		t.Fatalf("backup bytes = %q", got)
	}
}

func TestRecoverZeroByteCoordinatorRefusesNonZeroAndExistingBackup(t *testing.T) {
	path := coordinatorFixture(t, []byte("not-zero"))
	if _, err := RecoverZeroByteCodexCoordinator(time.Now()); err == nil {
		t.Fatal("non-zero coordinator recovered")
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != "not-zero" {
		t.Fatalf("non-zero fixture changed: %q %v", got, err)
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	if err := os.WriteFile(path+".zero-byte-backup-20260821T120000.000Z", []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := RecoverZeroByteCodexCoordinator(now); err == nil {
		t.Fatal("existing backup was overwritten")
	}
	if info, err := os.Stat(path); err != nil || info.Size() != 0 {
		t.Fatalf("source changed after refusal: %v %v", info, err)
	}
}
