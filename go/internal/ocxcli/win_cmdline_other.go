//go:build !windows

package ocxcli

// Non-Windows half of the launcher spawn seam: shims are spawned directly on
// POSIX, so there is no verbatim command line to apply.

import "os/exec"

func applyWindowsCommandLine(child *exec.Cmd, file string, argv []string) {}
