package tray

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type Heartbeat struct {
	PID       int       `json:"pid"`
	HostPID   int       `json:"hostPid,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

type HeartbeatStatus struct {
	Heartbeat Heartbeat
	Stale     bool
}

type heartbeatWire struct {
	PID       int   `json:"pid"`
	HostPID   int   `json:"hostPid,omitempty"`
	Timestamp int64 `json:"timestamp"`
}

func WriteHeartbeat(path string, heartbeat Heartbeat) error {
	if heartbeat.PID <= 0 {
		return fmt.Errorf("heartbeat PID must be positive")
	}
	if heartbeat.Timestamp.IsZero() {
		heartbeat.Timestamp = time.Now().UTC()
	}
	data, err := json.Marshal(heartbeatWire{PID: heartbeat.PID, HostPID: heartbeat.HostPID, Timestamp: heartbeat.Timestamp.UnixMilli()})
	if err != nil {
		return fmt.Errorf("encode tray heartbeat: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create tray state directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".tray-heartbeat-*")
	if err != nil {
		return fmt.Errorf("create tray heartbeat: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("write tray heartbeat: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := replaceOwnedFile(temporaryPath, path); err != nil {
		return fmt.Errorf("replace tray heartbeat: %w", err)
	}
	return nil
}

func ReadHeartbeat(path string, staleAfter time.Duration, now time.Time) (HeartbeatStatus, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return HeartbeatStatus{}, err
	}
	var wire heartbeatWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return HeartbeatStatus{}, fmt.Errorf("decode tray heartbeat: %w", err)
	}
	if wire.PID <= 0 || wire.Timestamp <= 0 {
		return HeartbeatStatus{}, fmt.Errorf("invalid tray heartbeat")
	}
	heartbeat := Heartbeat{PID: wire.PID, HostPID: wire.HostPID, Timestamp: time.UnixMilli(wire.Timestamp).UTC()}
	stale := staleAfter > 0 && now.Sub(heartbeat.Timestamp) > staleAfter
	return HeartbeatStatus{Heartbeat: heartbeat, Stale: stale}, nil
}

func replaceOwnedFile(temporaryPath, path string) error {
	if err := os.Rename(temporaryPath, path); err == nil {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Rename(temporaryPath, path)
}

type HeartbeatWriter struct {
	Path     string
	PID      int
	HostPID  int
	Interval time.Duration
}

func (writer HeartbeatWriter) Run(ctx context.Context) error {
	interval := writer.Interval
	if interval <= 0 {
		interval = 3 * time.Second
	}
	write := func() error {
		return WriteHeartbeat(writer.Path, Heartbeat{PID: writer.PID, HostPID: writer.HostPID, Timestamp: time.Now().UTC()})
	}
	if err := write(); err != nil {
		return err
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	defer os.Remove(writer.Path)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := write(); err != nil {
				return err
			}
		}
	}
}
