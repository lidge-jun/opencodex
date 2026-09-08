//go:build linux

package ocxcli

// Faithful-enough port of src/codex/app-server-processes.ts listUnixProcSnapshots
// + isCodexAppServerCommandLine so `ocx sync --restart-codex` /
// `ocx sync-cache --restart-codex` warn about (and stop) the same long-lived
// Codex processes the TypeScript CLI would. Matching stays deliberately narrow:
// a codex/codex.opencodex-real/triple basename (or codex-code-mode-host
// entrypoint), then `app-server` as the first non-option subcommand token.

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type codexAppServerProcess struct {
	pid         int
	commandLine string
}

var codexTripleBasenameRe = regexp.MustCompile(`^codex-[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?(?:\.exe|\.cmd)?$`)

var codexLauncherBasenames = map[string]bool{
	"codex": true, "codex.exe": true, "codex.cmd": true,
	"codex.opencodex-real": true, "codex.opencodex-real.cmd": true, "codex.opencodex-real.ps1": true,
}

var codexInterpreterBasenames = map[string]bool{
	"node": true, "node.exe": true, "bun": true, "bun.exe": true, "deno": true, "deno.exe": true,
}

// Codex global options that consume a following value when written without `=`.
var codexOptionsWithValue = map[string]bool{
	"--enable": true, "--disable": true, "--config": true, "-c": true,
	"--profile": true, "-p": true, "--model": true, "-m": true,
	"--sandbox": true, "-s": true, "--ask-for-approval": true, "-a": true,
	"--local-provider": true, "--add-dir": true, "--cd": true, "-C": true,
	"--color": true, "--image": true, "-i": true,
	"--output-schema": true, "--output-last-message": true, "-o": true,
}

func tokenBasename(token string) string {
	base := strings.ToLower(strings.ReplaceAll(token, "\\", "/"))
	if slash := strings.LastIndexByte(base, '/'); slash >= 0 {
		base = base[slash+1:]
	}
	return base
}

func isCodexExecutableToken(token string) bool {
	base := tokenBasename(token)
	return codexLauncherBasenames[base] || codexTripleBasenameRe.MatchString(base)
}

func isCodeModeHostToken(token string) bool {
	base := tokenBasename(token)
	return base == "codex-code-mode-host" || base == "codex-code-mode-host.exe"
}

func isInterpreterToken(token string) bool {
	return codexInterpreterBasenames[tokenBasename(token)]
}

func advancePastCodexGlobalOption(tokens []string, index int) int {
	next := index + 1
	token := tokens[index]
	if strings.HasPrefix(token, "-") && token != "-" && token != "--" {
		name := token
		if strings.HasPrefix(token, "--") {
			if eq := strings.IndexByte(token, '='); eq >= 0 {
				name = token[:eq]
			}
		} else if eq := strings.IndexByte(token, '='); eq >= 0 {
			name = token[:eq]
		}
		if !strings.Contains(token, "=") && codexOptionsWithValue[name] && next < len(tokens) && !strings.HasPrefix(tokens[next], "-") {
			next++
		}
	}
	return next
}

// isCodexAppServerCommandLine returns true when the token stream names a
// codex launcher and app-server as its first real subcommand, or starts with
// codex-code-mode-host. `codex -- <prompt>` is never a match.
func isCodexAppServerCommandLine(commandLine string) bool {
	trimmed := strings.TrimSpace(commandLine)
	if trimmed == "" {
		return false
	}
	tokens := tokenizeCodexCommandLine(trimmed)
	if len(tokens) == 0 {
		return false
	}
	if isCodeModeHostProcess(tokens) {
		return true
	}
	// npm-installed Codex runs as `node <codex path> app-server`; drop one
	// interpreter and re-scan, exactly like the TS matcher.
	if isInterpreterToken(tokens[0]) && len(tokens) > 1 && isCodexExecutableToken(tokens[1]) {
		tokens = tokens[1:]
	}
	if !isCodexExecutableToken(tokens[0]) {
		return false
	}
	for i := 1; i < len(tokens); i++ {
		token := tokens[i]
		if token == "--" {
			return false
		}
		if strings.HasPrefix(token, "-") {
			i = advancePastCodexGlobalOption(tokens, i) - 1
			continue
		}
		return strings.EqualFold(token, "app-server")
	}
	return false
}

func isCodeModeHostProcess(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}
	if isCodeModeHostToken(tokens[0]) {
		return true
	}
	return isInterpreterToken(tokens[0]) && len(tokens) > 1 && isCodeModeHostToken(tokens[1])
}

func tokenizeCodexCommandLine(commandLine string) []string {
	var tokens []string
	var current strings.Builder
	var quote byte
	for i := 0; i < len(commandLine); i++ {
		ch := commandLine[i]
		if quote != 0 {
			if ch == quote {
				quote = 0
			} else {
				current.WriteByte(ch)
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			continue
		}
		if ch == ' ' || ch == '\t' {
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteByte(ch)
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

// listCodexAppServerProcesses scans /proc for the current uid, mirroring
// listUnixProcSnapshots. Enumeration failure reads as "no processes" (the TS
// restart contract: never signal something we could not verify).
func listCodexAppServerProcesses() []codexAppServerProcess {
	uid := os.Geteuid()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var matched []codexAppServerProcess
	seen := map[int]bool{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 1 {
			continue
		}
		status, err := os.ReadFile("/proc/" + entry.Name() + "/status")
		if err != nil {
			continue
		}
		processUid := parseProcStatusUid(string(status))
		if processUid != nil && *processUid != uid {
			continue
		}
		cmdline, err := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if err != nil {
			continue
		}
		if len(cmdline) == 0 {
			continue
		}
		parts := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")
		if len(parts) == 0 {
			continue
		}
		commandLine := strings.TrimSpace(strings.Join(parts, " "))
		if commandLine == "" {
			continue
		}
		if seen[pid] || !isCodexAppServerCommandLine(commandLine) {
			continue
		}
		seen[pid] = true
		matched = append(matched, codexAppServerProcess{pid: pid, commandLine: commandLine})
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i].pid < matched[j].pid })
	return matched
}

func parseProcStatusUid(status string) *int {
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if value, err := strconv.Atoi(fields[1]); err == nil {
					return &value
				}
			}
			return nil
		}
	}
	return nil
}

// codexAppServerSignal sends SIGTERM to one matched app-server (Unix semantics:
// graceful, never escalated).
func codexAppServerSignal(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

// codexAppServerAlive reports whether the pid still exists (kill-0 probe).
func codexAppServerAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// afterCatalogWriteHandleAppServers mirrors afterCatalogWriteHandleAppServers
// in src/codex/app-server-processes.ts: warn about matched app-servers after a
// real catalog/cache write, or SIGTERM them when --restart-codex was passed.
// In a fixture environment no Codex app-server process is running, so both the
// warn and restart branches are silent there.
func formatStaleCodexAppServerWarning(processes []codexAppServerProcess) string {
	pids := make([]string, 0, len(processes))
	for _, process := range processes {
		pids = append(pids, strconv.Itoa(process.pid))
	}
	suffix := ""
	if len(processes) > 1 {
		suffix = "s"
	}
	return "WARNING: " + strconv.Itoa(len(processes)) + " Codex app-server process(es) still running (PID" + suffix + ": " + strings.Join(pids, ", ") + "). " +
		"Disk catalog/cache were updated, but Codex may keep showing the old model list until those processes restart. " +
		"Re-run with `ocx sync --restart-codex` (or `ocx sync-cache --restart-codex`) to send SIGTERM only to matching app-server processes. " +
		"On Windows the desktop app itself may also need a full restart (`ocx sync --restart-desktop-app`). " +
		"Active turns may be interrupted."
}

func afterCatalogWriteHandleAppServers(deps Deps, restartCodex, toStderr bool) {
	logOut := deps.Stdout
	logErr := deps.Stderr
	if toStderr {
		logOut = deps.Stderr
	}
	processes := listCodexAppServerProcesses()
	if len(processes) == 0 {
		return
	}
	if !restartCodex {
		fmt.Fprintln(logErr, formatStaleCodexAppServerWarning(processes))
		return
	}
	pids := make([]string, 0, len(processes))
	for _, process := range processes {
		pids = append(pids, strconv.Itoa(process.pid))
	}
	fmt.Fprintf(logOut, "Stopping Codex app-server process(es): %s (active turns may be interrupted).\n", strings.Join(pids, ", "))
	var stopped, surviving []string
	deadline := time.Now().Add(2 * time.Second)
	for _, process := range processes {
		if err := codexAppServerSignal(process.pid); err != nil {
			if codexAppServerAlive(process.pid) {
				surviving = append(surviving, strconv.Itoa(process.pid))
			} else {
				stopped = append(stopped, strconv.Itoa(process.pid))
			}
			continue
		}
		if waitForCodexAppServerExit(process.pid, deadline) {
			stopped = append(stopped, strconv.Itoa(process.pid))
		} else {
			surviving = append(surviving, strconv.Itoa(process.pid))
		}
	}
	if len(stopped) > 0 {
		fmt.Fprintf(logOut, "Stopped Codex app-server PID(s): %s\n", strings.Join(stopped, ", "))
	}
	if len(surviving) > 0 {
		fmt.Fprintf(logErr, "Codex app-server PID(s) still running after SIGTERM: %s. Stop them manually if the model list stays stale.\n", strings.Join(surviving, ", "))
	}
}

func waitForCodexAppServerExit(pid int, deadline time.Time) bool {
	for {
		if !codexAppServerAlive(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}
