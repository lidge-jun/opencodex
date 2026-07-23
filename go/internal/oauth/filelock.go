package oauth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type fileLock struct {
	file *os.File
}

func acquireFileLock(ctx context.Context, path string) (*fileLock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create lock directory: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	_ = f.Chmod(0o600)

	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		err = tryLockFile(f)
		if err == nil {
			return &fileLock{file: f}, nil
		}
		if !errors.Is(err, errLockBusy) {
			_ = f.Close()
			return nil, fmt.Errorf("lock credential file: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, fmt.Errorf("lock credential file: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (l *fileLock) release() error {
	if l == nil || l.file == nil {
		return nil
	}
	err := unlockFile(l.file)
	closeErr := l.file.Close()
	l.file = nil
	if err != nil {
		return err
	}
	return closeErr
}
