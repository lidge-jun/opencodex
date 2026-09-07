//go:build windows

package ocxcli

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

var wmicCommandLinePattern = regexp.MustCompile(`(?m)^CommandLine=(.*)$`)

// readProcessCommandLine mirrors the Windows portion of the TypeScript probe.
// Executables are built from GetSystemDirectory rather than PATH or environment
// variables because this probe guards destructive process actions.
func readProcessCommandLine(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("invalid pid")
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil || systemDir == "" {
		if err == nil {
			err = errors.New("empty system directory")
		}
		return "", fmt.Errorf("resolve trusted Windows system directory: %w", err)
	}

	wmic := filepath.Join(systemDir, "wbem", "WMIC.exe")
	if output, runErr := runWindowsProcessProbe(wmic,
		"process", "where", "ProcessId="+strconv.Itoa(pid), "get", "CommandLine", "/VALUE",
	); runErr == nil {
		if match := wmicCommandLinePattern.FindStringSubmatch(strings.ReplaceAll(output, "\r", "")); len(match) == 2 {
			if commandLine := strings.TrimSpace(match[1]); commandLine != "" {
				return commandLine, nil
			}
		}
	}

	powershell := filepath.Join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe")
	output, err := runWindowsProcessProbe(powershell,
		"-NoProfile",
		"-NoLogo",
		"-NonInteractive",
		"-Command",
		`(Get-CimInstance Win32_Process -Filter "ProcessId = `+strconv.Itoa(pid)+`").CommandLine`,
	)
	if err != nil {
		return "", fmt.Errorf("inspect process command line: %w", err)
	}
	if commandLine := strings.TrimSpace(output); commandLine != "" {
		return commandLine, nil
	}
	return "", errors.New("process command line is empty")
}

func runWindowsProcessProbe(executable string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", err
	}
	return string(output), nil
}
