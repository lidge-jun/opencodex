package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const shimMarker = "opencodex codex autostart shim"

type ShimState struct {
	Platform    string `json:"platform"`
	WrapperPath string `json:"wrapperPath"`
	BackupPath  string `json:"backupPath"`
}

type ShimInstallOptions struct {
	ExecutablePath string
	OpenCodexPath  string
	StatePath      string
	GOOS           string
}

func DiscoverCodexExecutables(pathValue, goos string) []string {
	if goos == "" {
		goos = runtime.GOOS
	}
	separator := string(os.PathListSeparator)
	if goos == "windows" {
		separator = ";"
	}
	names := []string{"codex"}
	if goos == "windows" {
		names = []string{"codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"}
	}
	seen := map[string]bool{}
	var found []string
	for _, directory := range strings.Split(pathValue, separator) {
		if strings.TrimSpace(directory) == "" {
			continue
		}
		for _, name := range names {
			candidate := filepath.Join(directory, name)
			info, err := os.Stat(candidate)
			if err != nil || info.IsDir() || isShimFile(candidate) || seen[candidate] {
				continue
			}
			seen[candidate] = true
			found = append(found, candidate)
		}
	}
	sort.Strings(found)
	return found
}

func FindCodexOnPath(pathValue, goos string) (string, error) {
	found := DiscoverCodexExecutables(pathValue, goos)
	if len(found) == 0 {
		return "", errors.New("could not find a Codex executable on PATH")
	}
	return found[0], nil
}

func BuildUnixShim(realCodexPath, openCodexPath string) string {
	return fmt.Sprintf(`#!/usr/bin/env sh
# %s
case "${OCX_SHIM_BYPASS:-}:$1" in
  :features|:help|:login|:logout|:mcp|:completion|:--help|:-h|:--version|:-V|?:*) ;;
  *) %s ensure >/dev/null 2>&1 || true ;;
esac
exec %s "$@"
`, shimMarker, shellQuote(openCodexPath), shellQuote(realCodexPath))
}

// BuildWindowsShim uses start /b only for the service bootstrap; call waits for
// the real Codex process so exit status and Ctrl-C semantics remain transparent.
func BuildWindowsShim(realCodexPath, openCodexPath string) string {
	return fmt.Sprintf("@echo off\r\nrem %s\r\n"+
		"if not \"%%OCX_SHIM_BYPASS%%\"==\"\" goto run_codex\r\n"+
		"if /I \"%%~1\"==\"features\" goto run_codex\r\n"+
		"if /I \"%%~1\"==\"login\" goto run_codex\r\n"+
		"if /I \"%%~1\"==\"logout\" goto run_codex\r\n"+
		"start \"\" /b %s ensure ^>nul 2^>nul\r\n"+
		":run_codex\r\ncall %s %%*\r\nexit /b %%ERRORLEVEL%%\r\n",
		shimMarker, batchQuote(openCodexPath), batchQuote(realCodexPath))
}

func BuildPowerShellShim(realCodexPath, openCodexPath string) string {
	return fmt.Sprintf(`#!/usr/bin/env pwsh
# %s
$internal = @('features', 'help', 'login', 'logout', 'mcp', 'completion')
if (-not $env:OCX_SHIM_BYPASS -and $internal -notcontains $args[0]) {
  Start-Process -WindowStyle Hidden -FilePath %s -ArgumentList @('ensure')
}
& %s @args
exit $LASTEXITCODE
`, shimMarker, powershellQuote(openCodexPath), powershellQuote(realCodexPath))
}

func InstallCodexShim(options ShimInstallOptions) (ShimState, error) {
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	if options.ExecutablePath == "" || options.OpenCodexPath == "" || options.StatePath == "" {
		return ShimState{}, errors.New("executable, opencodex, and state paths are required")
	}
	if isShimFile(options.ExecutablePath) {
		state, err := readShimState(options.StatePath)
		return state, err
	}
	extension := strings.ToLower(filepath.Ext(options.ExecutablePath))
	if goos == "windows" && extension == ".exe" {
		return ShimState{}, errors.New("refusing to replace codex.exe with a script wrapper")
	}
	backupPath := backupPathFor(options.ExecutablePath)
	if _, err := os.Stat(backupPath); err == nil {
		return ShimState{}, fmt.Errorf("refusing to overwrite existing backup %s", backupPath)
	}
	if err := os.Rename(options.ExecutablePath, backupPath); err != nil {
		return ShimState{}, err
	}
	rollback := true
	defer func() {
		if rollback {
			_ = os.Rename(backupPath, options.ExecutablePath)
		}
	}()
	var script string
	switch {
	case goos != "windows":
		script = BuildUnixShim(backupPath, options.OpenCodexPath)
	case extension == ".ps1":
		script = "\ufeff" + BuildPowerShellShim(backupPath, options.OpenCodexPath)
	default:
		script = BuildWindowsShim(backupPath, options.OpenCodexPath)
	}
	if err := atomicWriteFile(options.ExecutablePath, []byte(script), 0o755); err != nil {
		return ShimState{}, err
	}
	state := ShimState{Platform: goos, WrapperPath: options.ExecutablePath, BackupPath: backupPath}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return ShimState{}, err
	}
	if err := atomicWriteFile(options.StatePath, append(encoded, '\n'), 0o600); err != nil {
		_ = os.Remove(options.ExecutablePath)
		return ShimState{}, err
	}
	rollback = false
	return state, nil
}

func UninstallCodexShim(statePath string) (bool, error) {
	state, err := readShimState(statePath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	if isShimFile(state.WrapperPath) {
		if err := os.Remove(state.WrapperPath); err != nil && !os.IsNotExist(err) {
			return false, err
		}
	} else if _, err := os.Stat(state.WrapperPath); err == nil {
		return false, errors.New("wrapper path is no longer owned by OpenCodex")
	}
	if _, err := os.Stat(state.BackupPath); err == nil {
		if err := os.Rename(state.BackupPath, state.WrapperPath); err != nil {
			return false, err
		}
	}
	if err := os.Remove(statePath); err != nil && !os.IsNotExist(err) {
		return false, err
	}
	return true, nil
}

func readShimState(path string) (ShimState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ShimState{}, err
	}
	var state ShimState
	if err := json.Unmarshal(data, &state); err != nil {
		return ShimState{}, fmt.Errorf("parse shim state: %w", err)
	}
	if state.WrapperPath == "" || state.BackupPath == "" {
		return ShimState{}, errors.New("invalid shim state")
	}
	return state, nil
}

func backupPathFor(path string) string {
	extension := filepath.Ext(path)
	if extension == "" {
		return path + ".opencodex-real"
	}
	return strings.TrimSuffix(path, extension) + ".opencodex-real" + extension
}

func isShimFile(path string) bool {
	data, err := os.ReadFile(path)
	return err == nil && strings.Contains(string(data), shimMarker)
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
func batchQuote(value string) string { return `"` + strings.ReplaceAll(value, `"`, "") + `"` }
func powershellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
