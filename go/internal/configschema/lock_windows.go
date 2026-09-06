//go:build windows

package configschema

import (
	"os"
	"sync"
)

// This keeps cross-compiled builds dependency-free. Native Windows LockFileEx
// wiring belongs to the native config command increment.
var windowsLocks sync.Map

func tryLockPath(path string) (release func(), acquired bool, err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, err
	}
	_ = f.Close()
	_, loaded := windowsLocks.LoadOrStore(path, struct{}{})
	if loaded {
		return nil, false, nil
	}
	return func() { windowsLocks.Delete(path) }, true, nil
}
