//go:build windows

package ocxcli

// Windows-only half of the launcher spawn seam. When the MiniMax target is a
// `.cmd`/`.bat` shim, launcherCommandInvocation builds the hand-escaped
// `ComSpec /d /s /c "<line>"` invocation with cross-spawn escape semantics
// (escapeCmdArg/escapeCmdCommand). os/exec re-quotes argv with its own rules
// unless the raw command line is supplied verbatim, which would mangle the
// `^`/quote escaping built for cmd.exe — so the fully assembled line is handed
// to CreateProcess through SysProcAttr.CmdLine instead.

import (
	"os/exec"
	"strings"
	"syscall"
)

func applyWindowsCommandLine(child *exec.Cmd, file string, argv []string) {
	parts := make([]string, 0, len(argv)+1)
	parts = append(parts, file)
	parts = append(parts, argv...)
	child.SysProcAttr = &syscall.SysProcAttr{CmdLine: strings.Join(parts, " ")}
}
