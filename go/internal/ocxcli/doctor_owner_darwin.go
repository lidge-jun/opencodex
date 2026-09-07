//go:build darwin

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
// evidence TypeScript validates immediately before recovery rename. Darwin's
// syscall.Stat_t spells the timestamp fields *spec rather than the Linux *t.
func doctorSameFullFileIdentity(left, right os.FileInfo) bool {
	a, aok := left.Sys().(*syscall.Stat_t)
	b, bok := right.Sys().(*syscall.Stat_t)
	return aok && bok && a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size &&
		a.Mtimespec.Sec == b.Mtimespec.Sec && a.Mtimespec.Nsec == b.Mtimespec.Nsec &&
		a.Ctimespec.Sec == b.Ctimespec.Sec && a.Ctimespec.Nsec == b.Ctimespec.Nsec
}
