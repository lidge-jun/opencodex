//go:build !windows

package oauth

import "os"

func atomicReplace(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}
