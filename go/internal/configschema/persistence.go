package configschema

import (
	"context"
	"os"
	"path/filepath"
	"time"
)

// WithPathLock serializes cooperative Go config writers using an OS advisory
// lock held on a stable sidecar beside config.json. Keeping the sidecar stable
// is essential: deleting it after release would let two writers lock different
// inodes. A crashed process releases its OS lock automatically.
//
// TypeScript currently coordinates config mutations through BEGIN IMMEDIATE on
// config-mutation.sqlite. This preliminary package deliberately does not claim
// to join that transaction: wiring a SQLite driver and the generation protocol
// belongs with the native config command that will consume this package.
func WithPathLock(ctx context.Context, path string, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	lock := path + ".lock"
	for {
		release, acquired, err := tryLockPath(lock)
		if err != nil {
			return err
		}
		if acquired {
			defer release()
			return fn()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// WriteAtomicLocked is the persistence transaction used by a future Go-native
// config dispatcher: serialize in canonical order, fsync a 0600 temp file, and
// publish it through rename while holding the shared lock.
func WriteAtomicLocked(ctx context.Context, path string, config *Normalized) error {
	return WithPathLock(ctx, path, func() error {
		data, err := config.IndentedJSON()
		if err != nil {
			return err
		}
		data = append(data, '\n')
		return writeConfigBytesAtomic(path, data)
	})
}

// writeConfigBytesAtomic publishes already-serialized JSON using the same
// 0600 temp/fsync/rename protocol as WriteAtomicLocked. The SQLite revalidated
// transaction owns cross-runtime serialization when this helper is called from
// WithRevalidatedConfigMutation.
func writeConfigBytesAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".config.json-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
