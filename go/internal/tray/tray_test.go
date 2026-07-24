package tray

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHeartbeatWriteReadAndStaleness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray-heartbeat.json")
	now := time.Date(2026, time.July, 24, 1, 2, 3, 0, time.UTC)
	if err := WriteHeartbeat(path, Heartbeat{PID: 42, HostPID: 7, Timestamp: now}); err != nil {
		t.Fatal(err)
	}
	fresh, err := ReadHeartbeat(path, 15*time.Second, now.Add(14*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Stale || fresh.Heartbeat.PID != 42 || fresh.Heartbeat.HostPID != 7 {
		t.Fatalf("fresh heartbeat = %+v", fresh)
	}
	stale, err := ReadHeartbeat(path, 15*time.Second, now.Add(16*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !stale.Stale {
		t.Fatal("expected stale heartbeat")
	}
}

func TestReadHeartbeatRejectsInvalidAndMissingFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray-heartbeat.json")
	if _, err := ReadHeartbeat(path, time.Second, time.Now()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing heartbeat error = %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"pid":0,"timestamp":"bad"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadHeartbeat(path, time.Second, time.Now()); err == nil {
		t.Fatal("expected invalid heartbeat rejection")
	}
	if err := os.WriteFile(path, []byte(`{"pid":42}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadHeartbeat(path, time.Second, time.Now()); err == nil {
		t.Fatal("expected missing timestamp rejection")
	}
}
