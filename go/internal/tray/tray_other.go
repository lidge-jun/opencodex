//go:build !windows

package tray

func newManager(Config) (Manager, error) { return nil, ErrNotSupported }
