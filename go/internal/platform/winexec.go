//go:build windows

package platform

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// WindowsCommand resolves PATH/PATHEXT and routes batch shims through cmd.exe.
func WindowsCommand(command string, args ...string) *exec.Cmd {
	resolved := resolveWindowsCommand(command)
	extension := strings.ToLower(filepath.Ext(resolved))
	if extension != ".cmd" && extension != ".bat" {
		return exec.Command(resolved, args...)
	}
	parts := []string{escapeCMDCommand(resolved)}
	for _, arg := range args {
		parts = append(parts, escapeCMDArgument(arg))
	}
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	return exec.Command(comspec, "/d", "/s", "/c", `"`+strings.Join(parts, " ")+`"`)
}

func resolveWindowsCommand(command string) string {
	if filepath.Ext(command) != "" || strings.ContainsAny(command, `\\/`) {
		return command
	}
	extensions := filepath.SplitList(strings.ReplaceAll(defaultString(os.Getenv("PATHEXT"), ".COM;.EXE;.BAT;.CMD"), ";", string(os.PathListSeparator)))
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		for _, extension := range extensions {
			candidate := filepath.Join(dir, command+strings.ToLower(extension))
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	return command
}

func escapeCMDArgument(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	backslashes := 0
	for _, character := range value {
		if character == '\\' {
			backslashes++
			continue
		}
		if character == '"' {
			builder.WriteString(strings.Repeat("\\", backslashes*2+1))
			builder.WriteRune(character)
			backslashes = 0
			continue
		}
		builder.WriteString(strings.Repeat("\\", backslashes))
		backslashes = 0
		builder.WriteRune(character)
	}
	builder.WriteString(strings.Repeat("\\", backslashes*2))
	builder.WriteByte('"')
	return escapeCMDMeta(builder.String())
}

func escapeCMDCommand(value string) string { return escapeCMDMeta(value) }

func escapeCMDMeta(value string) string {
	var builder strings.Builder
	for _, character := range value {
		if strings.ContainsRune(`()[]%!^"`+"`"+`<>&|;, *?`, character) {
			builder.WriteByte('^')
		}
		builder.WriteRune(character)
	}
	return builder.String()
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
