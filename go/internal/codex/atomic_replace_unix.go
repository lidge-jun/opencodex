//go:build !windows

package codex

import "os"

func atomicReplace(source, destination string) error { return os.Rename(source, destination) }
