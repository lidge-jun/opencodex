package oauth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// inProcessLocks provides goroutine-level mutual exclusion on top of the
// OS file lock. macOS flock is process-scoped, so two goroutines in the same
// process can both succeed at flock simultaneously. The in-process mutex
// serialises them before the file lock is even attempted.
var inProcessLocks sync.Map // map[string]*sync.Mutex

func getInProcessMutex(path string) *sync.Mutex {
	v, _ := inProcessLocks.LoadOrStore(path, &sync.Mutex{})
	return v.(*sync.Mutex)
}

type fileLock struct {
	file *os.File
	mu   *sync.Mutex
}

func acquireFileLock(ctx context.Context, path string) (*fileLock, error) {
	// In-process mutex: serialise goroutines within the same binary.
	mu := getInProcessMutex(path)
	mu.Lock()

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		mu.Unlock()
		return nil, fmt.Errorf("create lock directory: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		mu.Unlock()
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	_ = f.Chmod(0o600)

	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		err = tryLockFile(f)
		if err == nil {
			return &fileLock{file: f, mu: mu}, nil
		}
		if !errors.Is(err, errLockBusy) {
			_ = f.Close()
			mu.Unlock()
			return nil, fmt.Errorf("lock credential file: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			mu.Unlock()
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
	if l.mu != nil {
		l.mu.Unlock()
	}
	if err != nil {
		return err
	}
	return closeErr
}
