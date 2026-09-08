//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package ocxcli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

// K on POSIX platforms: the exact SQLite lock byte the TypeScript side's
// bun:sqlite takes for BEGIN IMMEDIATE (SQLite RESERVED_BYTE = 0x40000000 +
// 0x1FF). Taking that single-byte write lock through fcntl makes a Go
// sync-cache contend with a TypeScript proxy holding K and vice versa
// (verified empirically against bun:sqlite, which honours the byte range), and
// two Go processes contend with each other through ordinary POSIX record
// locks. modernc.org/sqlite is deliberately NOT used here: its pure-Go VFS
// does not reproduce bun's locking layout, and the busy fixture the oracle
// drives must make the TS CLI observe contention.
const sqliteReservedByte int64 = 0x400001FF

// acquireCatalogWriteLock mirrors the TS acquisition sequence
// (withCatalogWriteSerialization): an existing K database must already be a
// regular file owned by the effective uid with mode 0600 — TS never repairs a
// misconfigured database, it reports unsafe-path and skips the write. A missing
// database is created 0600 and chmodded after creation. The lock itself is the
// SQLite reserved-byte write lock; the returned release function drops it and
// closes the file.
func acquireCatalogWriteLock(databasePath string) (func(), error) {
	absent := false
	if info, err := os.Lstat(databasePath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, errCatalogWriteUnsafe
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || uint64(stat.Uid) != uint64(os.Geteuid()) || (info.Mode().Perm()&0o777) != 0o600 {
			return nil, errCatalogWriteUnsafe
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	} else {
		absent = true
	}

	mode := os.O_RDWR
	if absent {
		mode |= os.O_CREATE
	}
	file, err := os.OpenFile(databasePath, mode, 0o600)
	if err != nil {
		return nil, err
	}
	if absent {
		_ = file.Chmod(0o600)
	}
	// Re-verify after open: the path must still be the plain file we opened and
	// must not have been swapped for a symlink (samePathIdentity on realpath).
	if info, err := os.Lstat(databasePath); err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errCatalogWriteUnsafe
	}
	if real, err := filepath.EvalSymlinks(databasePath); err != nil || real != databasePath {
		_ = file.Close()
		return nil, errCatalogWriteUnsafe
	}

	lock := unix.Flock_t{Type: unix.F_WRLCK, Whence: 0, Start: sqliteReservedByte, Len: 1}
	if err := unix.FcntlFlock(file.Fd(), unix.F_SETLK, &lock); err != nil {
		_ = file.Close()
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EAGAIN) {
			return nil, errCatalogWriteBusy
		}
		return nil, err
	}
	release := func() {
		unlock := unix.Flock_t{Type: unix.F_UNLCK, Whence: 0, Start: sqliteReservedByte, Len: 1}
		_ = unix.FcntlFlock(file.Fd(), unix.F_SETLK, &unlock)
		_ = file.Close()
	}
	return release, nil
}

// resolveCatalogWriteDatabasePath mirrors
// resolveCodexCatalogSerializationDatabasePath: /tmp (real, uid 0, sticky
// world-writable) + opencodex-runtime-v1-<uid>/catalog-write-locks/<sha256
// of the canonical home>.sqlite, every directory private and non-symlink.
func resolveCatalogWriteDatabasePath(canonicalCodexHome string) (string, error) {
	uid := os.Geteuid()
	realTmp, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		return "", err
	}
	info, err := os.Stat(realTmp)
	if err != nil || !info.IsDir() {
		return "", errors.New("the system temporary directory has unsafe ownership")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != 0 {
		return "", errors.New("the system temporary directory has unsafe ownership")
	}
	// Sticky world write/search bits must be present (drwxrwxrwt == 0o1777).
	if info.Mode()&os.ModeSticky == 0 || info.Mode().Perm()&0o003 != 0o003 {
		return "", errors.New("the system temporary directory lacks sticky world write/search permissions")
	}
	root := filepath.Join(realTmp, fmt.Sprintf("opencodex-runtime-v1-%d", uid))
	if err := ensurePrivateDir(root, uid); err != nil {
		return "", err
	}
	locks := filepath.Join(root, "catalog-write-locks")
	if err := ensurePrivateDir(locks, uid); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(canonicalCodexHome))
	return filepath.Join(locks, hex.EncodeToString(sum[:])+".sqlite"), nil
}

func ensurePrivateDir(path string, uid int) error {
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("the Codex coordinator namespace is not a real directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || uint64(stat.Uid) != uint64(uid) || (info.Mode().Perm()&0o777) != 0o700 {
		return errors.New("the Codex coordinator namespace has unsafe ownership or permissions")
	}
	return nil
}
