package ocxcli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// Native help text for the lifecycle families flipped in issue #53. Each string
// is byte-identical to the TypeScript CLI's `ocx <command> --help` output (the
// parity matrix in tests/go-cli-parity.test.ts asserts this).
const (
	codexShimHelp = "Usage: ocx codex-shim <install|status|uninstall|remove>\n\n" +
		"Auto-start the proxy when `codex` launches.\n\n" +
		"Use `remove` as an alias for `uninstall`.\n"
	ensureHelp  = "Usage: ocx ensure\n\nEnsure the proxy is running and Codex config/cache are current.\n"
	restartHelp = "Usage: ocx restart\n\nStop the proxy and restart it (background). Equivalent to stop + ensure.\n"
)

// codexAutoStartEnabled mirrors codexAutoStartEnabled in src/config.ts: the
// durable autostart switch is off only when the config file says so explicitly.
// The Go config reader keeps Raw so the decision reads the exact file value the
// TypeScript schema normalizer preserves.
func codexAutoStartEnabled() (bool, error) {
	cfg, err := config.Load()
	if err != nil {
		return false, err
	}
	raw, ok := cfg.Raw["codexAutoStart"]
	if !ok {
		return true, nil
	}
	value, isBool := raw.(bool)
	if !isBool {
		// A non-boolean value (string/number) is not `false`; the TypeScript
		// runtime's `config.codexAutoStart !== false` treats it as enabled.
		return true, nil
	}
	return value, nil
}

// clientLifecycleBlocked mirrors the disconnected guard the TypeScript
// ensure/restart dispatchers run before the autostart decision
// (readClientConnectionState in src/client/state.ts): a home configured as a
// client, or carrying a client key / runtimeRole that is not a plain
// standalone or hub role, never starts a local proxy and prints a mode error.
// The shallow mirror returns true for every state that is not provably
// disconnected so the caller delegates to the TypeScript owner, which owns the
// authoritative mode error bytes. The parity oracle homes (no client key, no
// runtimeRole, or a missing/empty config) are disconnected and stay native.
func clientLifecycleBlocked() (bool, error) {
	cfg, err := config.Load()
	if err != nil {
		// Unreadable/malformed config: the TypeScript owner backs it up and
		// re-derives state; not provably disconnected, so delegate.
		return true, nil
	}
	raw := cfg.Raw
	_, hasClient := raw["client"]
	if hasClient && raw["client"] == nil {
		hasClient = false
	}
	roleValue, hasRole := raw["runtimeRole"]
	if !hasClient {
		if !hasRole {
			return false, nil
		}
		role, isString := roleValue.(string)
		if !isString {
			return true, nil
		}
		switch role {
		case "standalone", "hub":
			return false, nil
		default:
			return true, nil
		}
	}
	return true, nil
}

// runEnsure implements `ocx ensure`. The deterministic no-side-effect refusal
// branch is native: when the home is a disconnected standalone (no client
// mode) and Codex autostart is disabled, the command must not start or touch a
// proxy, and prints the exact TypeScript bytes. Every other branch (client
// mode, spawn a proxy, sync Codex config/cache, reconcile a live proxy) owns
// process and Codex mutations that carry no passing oracle yet, so it routes
// to the TypeScript lifecycle owner until one exists.
func runEnsure(args []string, deps Deps) int {
	if blocked, _ := clientLifecycleBlocked(); blocked {
		return runDelegated(append([]string{"ensure"}, args...), deps)
	}
	enabled, err := codexAutoStartEnabled()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if !enabled {
		fmt.Fprintln(deps.Stdout, "Codex autostart is disabled.")
		return ExitOK
	}
	return runDelegated(append([]string{"ensure"}, args...), deps)
}

// runRestart implements `ocx restart`. Mirroring handleProxyRestart: a live
// proxy owns its own drain/replacement through the management API, and a
// stopped proxy degrades to the documented ensure-start behavior. The native
// branch is the deterministic refusal when the home is not in client mode,
// nothing is live, and Codex autostart is disabled; the live/start/client
// branches delegate to the TypeScript lifecycle owner until each carries an
// oracle.
func runRestart(args []string, deps Deps) int {
	if _, live := liveProxyEndpoint(deps); live {
		return runDelegated(append([]string{"restart"}, args...), deps)
	}
	if blocked, _ := clientLifecycleBlocked(); blocked {
		return runDelegated(append([]string{"restart"}, args...), deps)
	}
	enabled, err := codexAutoStartEnabled()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	if !enabled {
		fmt.Fprintln(deps.Stdout, "Codex autostart is disabled; no proxy was started.")
		return ExitOK
	}
	return runDelegated(append([]string{"restart"}, args...), deps)
}

// runServiceStatus implements the Go-owned `service status` read. It mirrors
// the TypeScript status verb only for the deterministic, side-effect-free
// registration states a platform oracle can exercise; the installed-state
// report reads the live service manager (systemctl is-enabled/is-active, stale
// baked paths, the Windows scheduler/SCM), so that branch stays with the
// TypeScript owner. Only `service status` reaches this function — OwnershipFor
// routes every other service verb to TypeScript at the dispatch gate.
func runServiceStatus(args []string, deps Deps) int {
	// Only `service status` (no backend flags) reaches this function —
	// OwnershipFor gates every other service verb to TypeScript. Backend flags
	// (--native/--scheduler) select a recorded backend and are part of the
	// richer status surface, so they stay delegated too.
	if len(args) != 1 || args[0] != "status" {
		return runDelegated(append([]string{"service"}, args...), deps)
	}
	dir, err := config.Dir()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	logPath := filepath.Join(dir, "service.log")
	summary := serviceStatusSummary(logPath)
	if summary == "" {
		// An installed (or otherwise non-deterministic) registration state:
		// delegate the report to the TypeScript owner for byte-exact output.
		return runDelegated([]string{"service", "status"}, deps)
	}
	fmt.Fprintf(deps.Stdout, "❌ %s\n", summary)
	fmt.Fprintf(deps.Stdout, "Diagnostics: logs: %s\n", logPath)
	return ExitOK
}

// serviceStatusSummary mirrors the not-installed and unsupported branches of
// diagnoseService in src/service.ts. It returns "" when the registration state
// is installed or otherwise requires the live service manager, so the caller
// delegates that report to the TypeScript owner.
func serviceStatusSummary(logPath string) string {
	if runtimeGOOS() == "linux" {
		if fileExists("/.dockerenv") {
			return "unsupported in Docker"
		}
		if !systemdPresent() {
			return "unsupported: systemd not found"
		}
		if fileExists(linuxServiceUnitPath()) {
			return ""
		}
		return "not installed (logs: " + logPath + ")"
	}
	if runtimeGOOS() == "darwin" {
		if fileExists(darwinServicePlistPath()) {
			return ""
		}
		return "not installed (logs: " + logPath + ")"
	}
	// Windows and other platforms: the status read depends on the scheduler or
	// SCM, so it is never native today.
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// systemdPresent mirrors isSystemd in src/service.ts: systemctl must answer a
// --version probe and a user-bus probe (or a per-user runtime dir must exist).
func systemdPresent() bool {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	if err := exec.Command("systemctl", "--version").Run(); err != nil {
		return false
	}
	if os.Getenv("XDG_RUNTIME_DIR") == "" {
		if uid := os.Getuid(); uid >= 0 {
			candidate := fmt.Sprintf("/run/user/%d", uid)
			if fileExists(candidate) {
				os.Setenv("XDG_RUNTIME_DIR", candidate)
			}
		}
	}
	if err := exec.Command("systemctl", "--user", "show-environment").Run(); err == nil {
		return true
	}
	return os.Getenv("XDG_RUNTIME_DIR") != ""
}

// linuxServiceUnitPath mirrors unitPath in src/service.ts for the Linux systemd
// user unit (real HOME, not OPENCODEX_HOME — the parity oracle runs on hosts
// with no opencodex-proxy unit installed).
func linuxServiceUnitPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join("/", ".config", "systemd", "user", "opencodex-proxy.service")
	}
	return filepath.Join(home, ".config", "systemd", "user", "opencodex-proxy.service")
}

// darwinServicePlistPath mirrors plistPath in src/service.ts (com.opencodex.proxy).
func darwinServicePlistPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join("/", "Library", "LaunchAgents", "com.opencodex.proxy.plist")
	}
	return filepath.Join(home, "Library", "LaunchAgents", "com.opencodex.proxy.plist")
}
