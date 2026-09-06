//go:build !windows

package ocxcli

import (
	"errors"
	"os"
	"syscall"
)

func doctorProcessAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || (!errors.Is(err, os.ErrProcessDone) && !errors.Is(err, syscall.ESRCH))
}
