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

// doctorSameFullFileIdentity matches the POSIX dev/inode/size/mtime/ctime
// evidence TypeScript validates immediately before recovery rename.
func doctorSameFullFileIdentity(left, right os.FileInfo) bool {
	a, aok := left.Sys().(*syscall.Stat_t)
	b, bok := right.Sys().(*syscall.Stat_t)
	return aok && bok && a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size &&
		a.Mtim.Sec == b.Mtim.Sec && a.Mtim.Nsec == b.Mtim.Nsec &&
		a.Ctim.Sec == b.Ctim.Sec && a.Ctim.Nsec == b.Ctim.Nsec
}
