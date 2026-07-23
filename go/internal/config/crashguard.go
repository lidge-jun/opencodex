package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"time"
)

// InstallCrashGuard returns a function intended for immediate defer:
//
//	defer config.InstallCrashGuard(path)()
//
// It recovers a panic, writes a redacted breadcrumb, and keeps the caller alive.
func InstallCrashGuard(logPath string) func() {
	return func() {
		value := recover()
		if value == nil {
			return
		}
		entry := fmt.Sprintf("\n[%s] panic\n%s\n%s\n", time.Now().UTC().Format(time.RFC3339Nano), RedactString(fmt.Sprint(value)), RedactString(string(debug.Stack())))
		_ = appendCrashEntry(logPath, []byte(entry))
	}
}

func appendCrashEntry(logPath string, entry []byte) error {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	_, err = file.Write(entry)
	return err
}
