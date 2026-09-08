package ocxcli

// ocx mcode / ocx mmx — the MiniMax external-CLI launchers (issue #54 launcher
// slice). These files port the TypeScript owner (src/cli/minimax.ts cmdMcode /
// cmdMmx plus the commandInvocation/win-exec spawn seam and the loopback text
// bridge) so the ownership flip keeps the surface identical: the same argument
// classification, the same loopback/hostname gates, the same wiring messages,
// the same child environment, and the same external-CLI spawn with inherited
// stdio and exit-code mapping.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

const (
	mcodeInstallHint = "❌ `mcode` CLI not found. Install MiniMax Code first: https://github.com/MiniMax-AI/minimax-code"
	mmxInstallHint   = "❌ `mmx` CLI not found. Install it first: npm install -g mmx-cli"
	loopbackKey      = "opencodex-loopback"
)

// mcodeHelp/mmxHelp mirror the registry-derived help the TypeScript CLI prints
// for `ocx help mcode|mmx` / `ocx mcode|mmx --help` (printSubcommandUsage).
const mcodeHelp = "Usage: ocx mcode [mcode args...]\n\nLaunch MiniMax Code through its managed OpenCodex provider.\n\nFirst connect the reversible file integration: ocx integration client enable --client mcode\nThe launcher verifies that custom_provider.opencodex targets the current loopback proxy before starting MCode.\nSelect custom_provider:opencodex/<model> from MCode's model picker.\n"

const mmxHelp = "Usage: ocx mmx text <chat|repl> [mmx args...]\n\nLaunch MiniMax CLI text commands through the proxy.\n\nOnly the official MMX Anthropic-compatible text surface is proxied.\nUse plain mmx for MiniMax-native image, video, speech, music, vision, search, quota, auth, config, file, and update commands.\nThe wrapper isolates ~/.mmx credentials and refuses --api-key/--base-url overrides.\n"

// launcherConfig is the OcxConfig projection the launchers read.
type launcherConfig struct {
	hostname string
	port     int
}

func readLauncherConfig() launcherConfig {
	cfg := launcherConfig{port: 10100}
	loaded, err := config.Load()
	if err != nil || loaded == nil {
		return cfg
	}
	if hostname, ok := loaded.Raw["hostname"].(string); ok && hostname != "" {
		cfg.hostname = hostname
	}
	if port, ok := loaded.Raw["port"].(json.Number); ok {
		if parsed, err := port.Int64(); err == nil && parsed > 0 && parsed <= 65535 {
			cfg.port = int(parsed)
		}
	}
	return cfg
}

// isLoopbackHostname mirrors isLoopbackHostname in src/server/auth-cors.ts: the
// config hostname is compared against the loopback family after trimming,
// lowercasing, and dropping one trailing dot. An absent hostname reads as
// loopback (TS treats undefined as 127.0.0.1; an empty stored string is caught
// by the schema and becomes undefined).
func isLoopbackHostname(hostname string) bool {
	value := strings.TrimSpace(hostname)
	if value == "" {
		return true
	}
	value = strings.ToLower(value)
	value = strings.TrimSuffix(value, ".")
	return value == "" || value == "localhost" || value == "127.0.0.1" || value == "::1" || value == "[::1]"
}

// standaloneInformational mirrors isStandaloneInformationalInvocation: only a
// single help/version token may bypass proxy wiring and spawn the CLI directly.
func standaloneInformational(args []string, client string) bool {
	if len(args) != 1 {
		return false
	}
	arg := args[0]
	if arg == "--help" || arg == "-h" || arg == "--version" {
		return true
	}
	if client == "mmx" {
		return arg == "-v"
	}
	return arg == "-v" || arg == "-V"
}

// mmxGlobalBooleanFlags mirrors MMX_GLOBAL_BOOLEAN_FLAGS.
var mmxGlobalBooleanFlags = map[string]bool{
	"--quiet": true, "--verbose": true, "--no-color": true, "--dry-run": true,
	"--non-interactive": true, "--yes": true, "--async": true, "--stream": true,
	"--no-stream": true, "--no-wait": true, "--help": true, "--version": true,
}

// mmxCommandPath mirrors mmxCommandPath: the positional command path after the
// official scanner's global-flag skipping.
func mmxCommandPath(argv []string) []string {
	path := []string{}
	for index := 0; index < len(argv); {
		arg := argv[index]
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "--") {
			equals := strings.Index(arg, "=")
			name := arg
			if equals >= 0 {
				name = arg[:equals]
			}
			if equals < 0 && !mmxGlobalBooleanFlags[name] {
				index += 2
			} else {
				index++
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			index++
			continue
		}
		path = append(path, arg)
		index++
	}
	return path
}

// mmxUnsafeOverride mirrors mmxUnsafeOverride: caller credentials and
// destinations may never override the proxy wrapper.
func mmxUnsafeOverride(argv []string) string {
	for _, arg := range argv {
		if arg == "--api-key" || strings.HasPrefix(arg, "--api-key=") {
			return "--api-key"
		}
		if arg == "--base-url" || strings.HasPrefix(arg, "--base-url=") {
			return "--base-url"
		}
		if arg == "--region" || strings.HasPrefix(arg, "--region=") {
			return "--region"
		}
	}
	return ""
}

// spawnLauncherClient spawns the external CLI with inherited stdio, exactly
// like the TS spawnClient: ENOENT prints the install hint and exits 1, signal
// exits map to 1, and cmd.exe's 9009 on win32 also prints the hint. env=nil
// inherits the current process environment.
func spawnLauncherClient(command string, args []string, env []string, installHint string) int {
	file, argv, options := launcherCommandInvocation(command, args)
	child := exec.Command(file, argv...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.Env = env
	if options.windowsVerbatimArguments {
		child.Args = append([]string{file}, argv...)
	}
	if err := child.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			fmt.Fprintln(os.Stderr, installHint)
		} else {
			fmt.Fprintf(os.Stderr, "❌ Failed to launch %s: %s\n", command, err.Error())
		}
		return ExitFailure
	}
	err := child.Wait()
	if err == nil {
		return ExitOK
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if exitErr.ExitCode() == -1 {
			// Signaled: report 1 like the TS `signal ? 1 : code`.
			return ExitFailure
		}
		if osRuntime == "windows" && exitErr.ExitCode() == 9009 {
			fmt.Fprintln(os.Stderr, installHint)
		}
		return exitErr.ExitCode()
	}
	return ExitFailure
}

type launcherSpawnOptions struct {
	windowsVerbatimArguments bool
}

// launcherCommandInvocation ports commandInvocation in src/lib/win-exec.ts.
// On POSIX the bare name is spawned directly; on win32 the PATH×PATHEXT
// resolution and .cmd shim routing mirror the TS launcher.
func launcherCommandInvocation(command string, args []string) (string, []string, launcherSpawnOptions) {
	if osRuntime != "windows" {
		return command, args, launcherSpawnOptions{}
	}
	resolved := resolveWindowsCommandName(command)
	if !strings.HasSuffix(strings.ToLower(resolved), ".cmd") && !strings.HasSuffix(strings.ToLower(resolved), ".bat") {
		return resolved, args, launcherSpawnOptions{}
	}
	doubleEscape := strings.Contains(strings.ToLower(resolved), "node_modules\\.bin\\") || strings.Contains(strings.ToLower(resolved), "node_modules/.bin/")
	escapedArgs := make([]string, 0, len(args))
	for _, arg := range args {
		escapedArgs = append(escapedArgs, escapeCmdArg(arg, doubleEscape))
	}
	line := strings.Join(append([]string{escapeCmdCommand(resolved)}, escapedArgs...), " ")
	comspec := os.Getenv("ComSpec")
	if comspec == "" {
		comspec = "cmd.exe"
	}
	return comspec, []string{"/d", "/s", "/c", "\"" + line + "\""}, launcherSpawnOptions{windowsVerbatimArguments: true}
}

var cmdMeta = regexp.MustCompile("[()\\[\\]%!^\"`<>&|;, *?]")

func escapeCmdCommand(command string) string {
	return cmdMeta.ReplaceAllString(command, "^$0")
}

// escapeCmdArg mirrors cross-spawn escape.js argument(): quote + escape one
// argument for cmd.exe /d /s /c.
func escapeCmdArg(arg string, doubleEscape bool) string {
	var out strings.Builder
	backslashes := 0
	flush := func() {
		for i := 0; i < backslashes; i++ {
			out.WriteByte('\\')
		}
		backslashes = 0
	}
	for i := 0; i < len(arg); i++ {
		char := arg[i]
		if char == '\\' {
			backslashes++
			continue
		}
		if char == '"' {
			// A quote closes any preceding backslash run and is itself escaped:
			// 2n+1 backslashes precede the quote (cross-spawn's $1$1\" ).
			for j := 0; j < backslashes*2+1; j++ {
				out.WriteByte('\\')
			}
			out.WriteByte('"')
			backslashes = 0
			continue
		}
		flush()
		out.WriteByte(char)
	}
	// A trailing backslash run is doubled so it cannot escape the closing quote.
	for j := 0; j < backslashes*2; j++ {
		out.WriteByte('\\')
	}
	quoted := "\"" + out.String() + "\""
	quoted = cmdMeta.ReplaceAllString(quoted, "^$0")
	if doubleEscape {
		quoted = cmdMeta.ReplaceAllString(quoted, "^$0")
	}
	return quoted
}

func resolveWindowsCommandName(command string) string {
	env := os.Environ()
	lookup := func(name string) string {
		for _, entry := range env {
			key, value, found := strings.Cut(entry, "=")
			if found && strings.EqualFold(key, name) {
				return value
			}
		}
		return ""
	}
	if strings.ContainsAny(command, `\/`) || strings.Contains(command, ".") && strings.ContainsAny(command, `\`) {
		return command
	}
	if filepath.Ext(command) != "" || strings.Contains(command, "\\") || strings.Contains(command, "/") || filepath.IsAbs(command) {
		return command
	}
	extensions := strings.Split(lookup("PATHEXT"), ";")
	if len(extensions) == 0 || lookup("PATHEXT") == "" {
		extensions = []string{".COM", ".EXE", ".BAT", ".CMD"}
	}
	for _, dir := range strings.Split(lookup("PATH"), ";") {
		if dir == "" {
			continue
		}
		for _, extension := range extensions {
			if extension == "" {
				continue
			}
			candidate := filepath.Join(dir, command+strings.ToLower(extension))
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return command
}

// mcodeConfigPathError mirrors ClientPathError from the config-export module.
type mcodeConfigPathError struct{ message string }

func (e *mcodeConfigPathError) Error() string { return e.message }

// mcodeConfigPath mirrors mcodeConfigPath: MINIMAX_DATA_DIR, then the legacy
// MAVIS_DATA_DIR, then ~/.minimax, all with the config.yaml basename. Relative
// overrides are refused exactly like TS (ClientPathError).
func mcodeConfigPath(home string) (string, error) {
	primary := strings.TrimSpace(os.Getenv("MINIMAX_DATA_DIR"))
	if primary != "" {
		return absoluteClientConfigPath(primary, home, "MINIMAX_DATA_DIR")
	}
	legacy := strings.TrimSpace(os.Getenv("MAVIS_DATA_DIR"))
	if legacy != "" {
		return absoluteClientConfigPath(legacy, home, "MAVIS_DATA_DIR")
	}
	return filepath.Join(home, ".minimax", "config.yaml"), nil
}

func absoluteClientConfigPath(raw, home, variable string) (string, error) {
	trimmed := raw
	if trimmed == "~" {
		return filepath.Join(home, "config.yaml"), nil
	}
	if strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, `~\`) {
		return filepath.Join(home, trimmed[2:], "config.yaml"), nil
	}
	if !filepath.IsAbs(trimmed) {
		return "", &mcodeConfigPathError{
			message: fmt.Sprintf("%s must be an absolute path or start with ~; \"%s\" depends on the working directory, so opencodex and the client would disagree about which file it names.", variable, trimmed),
		}
	}
	return filepath.Join(trimmed, "config.yaml"), nil
}

func userHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}

// mcodeOpenCodexBaseURL reads only the provider destination from the managed
// MCode config; a document this parser cannot read yields not-found, exactly
// like a Bun.YAML.parse failure on the TS side.
func mcodeOpenCodexBaseURL(text string) string {
	baseURL, ok := mcodeYamlBaseURL(text)
	if !ok {
		return ""
	}
	return baseURL
}

// normalizedMcodeBaseURL mirrors normalizedMcodeBaseUrl: only a clean http(s)
// origin (no credentials, no non-root path, no query/hash) counts.
func normalizedMcodeBaseURL(value string) string {
	if value == "" {
		return ""
	}
	return canonicalHttpOrigin(value)
}

// findLauncherProxy mirrors usableMinimaxLiveProxy + ensureProxy: only a live
// proxy bound on a loopback hostname is usable; anything else is ignored so the
// launcher never forwards a loopback-only client off-machine.
func findLauncherProxy(deps Deps) (state RuntimeState, found bool) {
	deps = defaults(deps)
	if state, err := deps.ReadRuntime(); err == nil {
		if !isLoopbackHostname(probeHost(state.Hostname)) {
			return RuntimeState{}, false
		}
		if proxyServesOpencodex(deps, state.Hostname, state.Port) {
			return state, true
		}
	}
	if candidate, ok := liveProxyEndpoint(deps); ok && isLoopbackHostname(probeHost(candidate.Hostname)) {
		return candidate, true
	}
	return RuntimeState{}, false
}

// ensureLauncherProxy starts the proxy when nothing live answers, then polls
// for up to 8 seconds (the TS ensureProxy deadline).
func ensureLauncherProxy(cfg launcherConfig, deps Deps) (RuntimeState, bool) {
	if state, ok := findLauncherProxy(deps); ok {
		return state, true
	}
	pinPort := strconv.Itoa(cfg.port)
	spawnDetachedSelf([]string{"start", "--port", pinPort}, deps)
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if state, ok := findLauncherProxy(deps); ok {
			return state, true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return RuntimeState{}, false
}

// runMcode ports cmdMcode.
func runMcode(args []string, deps Deps) int {
	if standaloneInformational(args, "mcode") {
		return spawnLauncherClient("mcode", args, nil, mcodeInstallHint)
	}
	cfg := readLauncherConfig()
	if !isLoopbackHostname(cfg.hostname) {
		fmt.Fprintln(deps.Stderr, "❌ MiniMax Code integration is loopback-only; its config cannot carry OpenCodex's dedicated remote-admission header.")
		return 2
	}
	state, ok := ensureLauncherProxy(cfg, deps)
	if !ok {
		fmt.Fprintln(deps.Stderr, "❌ Proxy did not become healthy after starting.")
		return 1
	}
	configPath, pathErr := mcodeConfigPath(userHomeDir())
	if pathErr != nil {
		var configErr *mcodeConfigPathError
		if errors.As(pathErr, &configErr) {
			fmt.Fprintf(deps.Stderr, "❌ %s\n", configErr.message)
			return 2
		}
	}
	var configuredBase string
	if configPath != "" {
		if text, readErr := os.ReadFile(configPath); readErr == nil {
			configuredBase = mcodeOpenCodexBaseURL(string(text))
		}
	}
	if configuredBase == "" {
		fmt.Fprintln(deps.Stderr, "❌ MiniMax Code is not connected. Run: ocx integration client enable --client mcode")
		return 2
	}
	expected := "http://" + probeHost(state.Hostname) + ":" + strconv.Itoa(state.Port)
	if normalizedMcodeBaseURL(configuredBase) != normalizedMcodeBaseURL(expected) {
		fmt.Fprintln(deps.Stderr, "❌ MiniMax Code's OpenCodex provider points at a stale proxy address. Re-run: ocx integration client enable --client mcode")
		return 2
	}
	fmt.Fprintf(deps.Stderr, "✅ MiniMax Code wired to %s; select custom_provider:opencodex/<model> in MCode.\n", expected)
	return spawnLauncherClient("mcode", args, nil, mcodeInstallHint)
}
