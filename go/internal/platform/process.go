package platform

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ProcessAlive reports whether pid names a process the current user can signal.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		output, commandErr := exec.Command("tasklist.exe", "/FI", "PID eq "+strconv.Itoa(pid), "/FO", "CSV", "/NH").Output()
		return commandErr == nil && strings.Contains(string(output), `"`+strconv.Itoa(pid)+`"`)
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func WaitForExit(ctx context.Context, pid int) bool {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for ProcessAlive(pid) {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
	return true
}

// GracefulShutdown asks the local management API to drain and stop.
func GracefulShutdown(ctx context.Context, baseURL, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/stop", nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("x-opencodex-api-key", token)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("graceful shutdown returned %s", response.Status)
	}
	return nil
}

// StopProcess uses graceful API shutdown first, then the platform termination ladder.
func StopProcess(ctx context.Context, pid int, baseURL, token string) error {
	if !ProcessAlive(pid) {
		return nil
	}
	if baseURL != "" && GracefulShutdown(ctx, baseURL, token) == nil {
		if WaitForExit(ctx, pid) {
			return nil
		}
	}
	return KillProcess(ctx, pid)
}

func KillProcess(ctx context.Context, pid int) error {
	if !ProcessAlive(pid) {
		return nil
	}
	if runtime.GOOS == "windows" {
		command := exec.CommandContext(ctx, "taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F")
		if output, err := command.CombinedOutput(); err != nil && ProcessAlive(pid) {
			return fmt.Errorf("taskkill: %w: %s", err, output)
		}
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	grace, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if WaitForExit(grace, pid) {
		return nil
	}
	if err := process.Signal(syscall.SIGKILL); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
