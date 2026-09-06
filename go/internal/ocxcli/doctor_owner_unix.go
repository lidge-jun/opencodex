//go:build !windows

package ocxcli

import (
	"os"
	"syscall"
)

func doctorOwnedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}
