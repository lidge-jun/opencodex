//go:build windows

package ocxcli

import "os"

// Windows ownership and reparse-point verification requires the token/SID
// probe used by TypeScript. Keep the namespace diagnostic refused there rather
// than treating a directory as trusted from a POSIX-style mode bit.
func doctorOwnedByCurrentUser(os.FileInfo) bool { return false }
