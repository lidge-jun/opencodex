package configschema

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteAtomicLockedPersistsOrderedJSONWithPrivateMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "config.json")
	normalized, err := NormalizeJSON([]byte(`{"providers":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomicLocked(context.Background(), path, normalized); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got)[:15] != "{\n  \"port\": 101" {
		t.Fatalf("unexpected persisted content: %s", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 0600", info.Mode().Perm())
	}
	lock, err := os.Stat(path + ".lock")
	if err != nil {
		t.Fatalf("stable lock sidecar missing: %v", err)
	}
	if lock.Mode().Perm() != 0o600 {
		t.Fatalf("lock mode = %o, want 0600", lock.Mode().Perm())
	}
}

func TestWithPathLockHonorsContextWhileAnotherWriterOwnsLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	release := make(chan struct{})
	entered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- WithPathLock(context.Background(), path, func() error { close(entered); <-release; return nil })
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err := WithPathLock(ctx, path, func() error { return nil })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want deadline exceeded", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
