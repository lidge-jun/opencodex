//go:build windows

package ocxcli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Windows K is best-effort. bun:sqlite on Windows serializes K through
// LockFileEx over SQLite's lock bytes; Go's std library exposes no fcntl, so
// this implementation coordinates Go processes with each other through an
// exclusive per-database lock file in the same namespace. Cross-runtime
// contention with a TypeScript-held K is not reproduced on Windows; the
// differential oracle's busy row is POSIX-only, and sequential cache writes
// (the flip's byte-compatibility contract) are unaffected.
//
// The namespace mirrors the TS side's shape (LocalAppData\OpenCodex\Runtime
// \v1\<account>) without the SID/PowerShell lookup, which the Go binary does
// not perform.
func acquireCatalogWriteLock(databasePath string) (func(), error) {
	lockPath := databasePath + ".lock"
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil, errCatalogWriteBusy
		}
		return nil, err
	}
	release := func() {
		_ = file.Close()
		_ = os.Remove(lockPath)
	}
	return release, nil
}

func resolveCatalogWriteDatabasePath(canonicalCodexHome string) (string, error) {
	localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if localAppData == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		localAppData = filepath.Join(home, "AppData", "Local")
	}
	account := strings.ToUpper(strings.TrimSpace(os.Getenv("USERNAME")))
	if account == "" {
		account = "unknown"
	}
	root := filepath.Join(localAppData, "OpenCodex", "Runtime", "v1", account)
	if err := os.MkdirAll(filepath.Join(root, "catalog-write-locks"), 0o700); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(canonicalCodexHome))
	return filepath.Join(root, "catalog-write-locks", hex.EncodeToString(sum[:])+".sqlite"), nil
}
