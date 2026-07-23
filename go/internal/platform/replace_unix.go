//go:build !windows

package platform

import "os"

func atomicReplace(source, destination string) error { return os.Rename(source, destination) }
