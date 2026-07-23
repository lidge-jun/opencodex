//go:build !windows

package platform

import "os/exec"

func WindowsCommand(command string, args ...string) *exec.Cmd { return exec.Command(command, args...) }
