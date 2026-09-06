//go:build windows

package ocxcli

import "os"

// Windows ownership and reparse-point verification requires the token/SID
// probe used by TypeScript. Keep the namespace diagnostic refused there rather
// than treating a directory as trusted from a POSIX-style mode bit.
func doctorOwnedByCurrentUser(os.FileInfo) bool { return false }

// Windows recovery is oracle-exempt until the native SID/reparse identity
// probe is available. The caller will already have refused the unsafe target.
func doctorSameFullFileIdentity(left, right os.FileInfo) bool {
	return os.SameFile(left, right) && left.Size() == right.Size() && left.ModTime().Equal(right.ModTime())
}
