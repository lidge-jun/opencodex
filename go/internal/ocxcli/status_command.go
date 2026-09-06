package ocxcli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// StatusCommandJSON is the ordered top-level JSON projection produced by the
// native status assembler. It matches collectStatus() in src/cli/status.ts.
type StatusCommandJSON struct {
	SchemaVersion   int                     `json:"schemaVersion"`
	Proxy           StatusProxyDomain       `json:"proxy"`
	Dashboard       StatusDashboardDomain   `json:"dashboard"`
	Listen          StatusListenDomain      `json:"listen"`
	Paths           StatusPathsDomain       `json:"paths"`
	Runtime         StatusRuntimeDomain     `json:"runtime"`
	CodexAutostart  bool                    `json:"codexAutostart"`
	Startup         StatusStartupDomain     `json:"startup"`
	DefaultProvider string                  `json:"defaultProvider"`
	Config          StatusConfigDomain      `json:"config"`
	Connection      StatusConnectionDomain  `json:"connection"`
	Service         StatusExternalSummary   `json:"service"`
	CodexShim       StatusExternalSummary   `json:"codexShim"`
	CodexPlugins    StatusPluginsDomain     `json:"codexPlugins"`
	CodexRuntime    StatusCodexRuntime      `json:"codexRuntime"`
	CodexHome       StatusCodexHome         `json:"codexHome"`
	ClaudeDesktop   StatusClaudeDesktop     `json:"claudeDesktop"`
	VersionSkew     StatusVersionSkewDomain `json:"versionSkew"`
}

type StatusCommandDeps struct {
	Domains  StatusDomainDeps
	External func() StatusExternalDomains
}

func CollectStatusCommand(deps StatusCommandDeps) StatusCommandJSON {
	domains := CollectStatusDomains(deps.Domains)
	externalFn := deps.External
	if externalFn == nil {
		externalFn = CollectStatusExternalDomains
	}
	external := externalFn()
	return StatusCommandJSON{
		SchemaVersion: domains.SchemaVersion, Proxy: domains.Proxy, Dashboard: domains.Dashboard, Listen: domains.Listen,
		Paths: domains.Paths, Runtime: domains.Runtime, CodexAutostart: domains.CodexAutostart, Startup: domains.Startup,
		DefaultProvider: domains.DefaultProvider, Config: domains.Config, Connection: domains.Connection, Service: external.Service,
		CodexShim: external.CodexShim, CodexPlugins: external.CodexPlugins, CodexRuntime: external.CodexRuntime,
		CodexHome: external.CodexHome, ClaudeDesktop: external.ClaudeDesktop, VersionSkew: domains.VersionSkew,
	}
}

// runStatus shares one collected snapshot between status --json and the text
// view, matching the TypeScript command's argument and exit-code contract.
func runStatus(args []string, deps Deps) int {
	wantsJSON := false
	for _, arg := range args {
		if arg == "--json" && !wantsJSON {
			wantsJSON = true
			continue
		}
		fmt.Fprintln(deps.Stderr, "Usage: ocx status [--json]")
		return ExitFailure
	}
	status := CollectStatusCommand(StatusCommandDeps{})
	if wantsJSON {
		encoder := json.NewEncoder(deps.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(status); err != nil {
			return ExitFailure
		}
		return ExitOK
	}
	statusTextConfigDiagnostic(deps.Stderr)
	renderStatusText(deps.Stdout, status)
	return ExitOK
}

func renderStatusText(w io.Writer, status StatusCommandJSON) {
	if status.Proxy.PID != nil || status.Proxy.Health.OK {
		label := "reachable, but PID file is missing or stale"
		if status.Proxy.PID != nil && status.Proxy.Health.OK {
			label = fmt.Sprintf("running (PID %d)", *status.Proxy.PID)
		} else if status.Proxy.PID != nil {
			label = fmt.Sprintf("PID file points to PID %d, but health check failed", *status.Proxy.PID)
		}
		fmt.Fprintf(w, "✅ Proxy: %s\n", label)
	} else {
		fmt.Fprintln(w, "❌ Proxy: not running")
	}
	fmt.Fprintf(w, "   Health: %s %s\n", status.Proxy.Health.URL, status.Proxy.Health.Message)
	if status.VersionSkew.Warning != nil {
		fmt.Fprintf(w, "   ⚠️  %s\n", *status.VersionSkew.Warning)
	}
	if status.Proxy.PID == nil && !status.Proxy.Health.OK {
		fmt.Fprintln(w, "   ↳ Not running — Codex/Claude requests will fail with connection errors.")
		fmt.Fprintln(w, "     Restart with 'ocx start', or install the persistent service: 'ocx service install'.")
	}
	fmt.Fprintf(w, "   Dashboard: %s\n", status.Dashboard.URL)
	fmt.Fprintf(w, "   Config: %s\n", status.Paths.Config)
	fmt.Fprintf(w, "   PID file: %s\n", status.Paths.PID)
	fmt.Fprintf(w, "   Runtime: %s\n", status.Paths.Runtime)
	runtimeSource := status.Runtime.Source
	if status.Runtime.OverrideEnv != nil {
		runtimeSource += " (" + *status.Runtime.OverrideEnv + ")"
	}
	fmt.Fprintf(w, "   Runtime source: %s\n", runtimeSource)
	fmt.Fprintf(w, "   Default provider: %s\n", status.DefaultProvider)
	remote := status.Connection.State
	if status.Connection.ServerURL != nil {
		remote += " (" + *status.Connection.ServerURL + ")"
	}
	fmt.Fprintf(w, "   Remote hub: %s\n", remote)
	if (status.Connection.State == "invalid" || status.Connection.State == "mismatched") && status.Connection.Reason != nil {
		fmt.Fprintf(w, "   ⚠️  %s\n", *status.Connection.Reason)
	}
	if status.CodexAutostart {
		fmt.Fprintln(w, "   Codex autostart: enabled")
	} else {
		fmt.Fprintln(w, "   Codex autostart: disabled")
	}
	fmt.Fprintf(w, "   Restart safety: %s\n", statusStartupSummary(status.Startup))
	fmt.Fprintf(w, "   routing=%s, service=%s, shim=%s\n", status.Startup.RoutingKind, statusServiceState(status.Startup), statusShimStateText(status.Startup))
	fmt.Fprintf(w, "   Service: %s\n", status.Service.Summary)
	fmt.Fprintf(w, "   %s\n", status.CodexShim.Summary)
	fmt.Fprintf(w, "   Codex runtime: %s\n", status.CodexRuntime.Path)
	version := "unknown"
	if status.CodexRuntime.Version != nil {
		version = *status.CodexRuntime.Version
	}
	fmt.Fprintf(w, "   Codex version: %s\n", version)
	fmt.Fprintf(w, "   Codex source: %s\n", status.CodexRuntime.Source)
	fmt.Fprintf(w, "   Codex home: %s\n", status.CodexHome.EffectiveCodexHome)
	if status.CodexHome.Warning != nil {
		fmt.Fprintf(w, "   ⚠️  %s\n      Action: %s\n", *status.CodexHome.Warning, *status.CodexHome.Action)
	}
	if status.CodexRuntime.CatalogClamp.Active {
		fmt.Fprintln(w, "   Catalog clamp: active")
	} else {
		fmt.Fprintln(w, "   Catalog clamp: inactive")
	}
	if len(status.CodexRuntime.CatalogClamp.RemovedEfforts) > 0 {
		fmt.Fprintf(w, "   Removed efforts: %s\n", strings.Join(status.CodexRuntime.CatalogClamp.RemovedEfforts, ", "))
	}
	if status.CodexRuntime.Warning != nil {
		fmt.Fprintf(w, "   ⚠️  %s\n", *status.CodexRuntime.Warning)
	}
	if status.CodexPlugins.Applicable {
		fmt.Fprintf(w, "   ✅ Codex bundled plugins: %s\n", status.CodexPlugins.Summary)
	}
	renderStatusOAuth(w)
}

func statusStartupSummary(health StatusStartupDomain) string {
	if health.Status == "native" {
		if health.RoutingKind == "custom-remote" {
			return "custom remote Codex routing (no local restart dependency)"
		}
		return "native Codex routing (no opencodex restart dependency)"
	}
	if health.Protection == "service" {
		return "protected by background service"
	}
	command := "ocx restore"
	if health.RecommendedCommand != nil {
		command = *health.RecommendedCommand
	}
	if health.RoutingKind == "unknown" {
		return "AT RISK after restart (Codex routing could not be verified; run '" + command + "')"
	}
	if health.RoutingKind == "custom-local" {
		return "AT RISK after restart (custom local gateway lifecycle is not managed by opencodex; run '" + command + "')"
	}
	if health.ShimCoverage == "cli-only" {
		return "AT RISK for Codex Desktop after restart (launcher shim covers CLI scripts only; run '" + command + "')"
	}
	if health.ServiceConflict {
		return "AT RISK after restart (background service managers conflict; run '" + command + "')"
	}
	if health.ServiceStale {
		return "AT RISK after restart (background service files are stale; run '" + command + "')"
	}
	if health.ServiceInstalled && !health.ServiceViable {
		return "AT RISK after restart (installed service is disabled, stopped, or unhealthy; run '" + command + "')"
	}
	return "AT RISK after restart (no viable background service; run '" + command + "')"
}
func statusServiceState(health StatusStartupDomain) string {
	if health.ServiceViable {
		return "viable"
	}
	if health.ServiceInstalled {
		return "installed-but-unhealthy"
	}
	return "absent"
}
func statusShimStateText(health StatusStartupDomain) string {
	if health.ShimHealthy {
		return "healthy"
	}
	if health.ShimInstalled {
		return "stale"
	}
	return "absent"
}

func renderStatusOAuth(w io.Writer) {
	providers := []string{"command-code", "xai", "anthropic", "kimi", "meta-muse", "nous", "kiro", "google-antigravity", "cursor", "github-copilot"}
	loggedIn := map[string]string{}
	if dir, err := config.Dir(); err == nil {
		if raw, readErr := os.ReadFile(filepath.Join(dir, "auth.json")); readErr == nil {
			var store map[string]any
			if json.Unmarshal(raw, &store) == nil {
				for provider, value := range store {
					if set, ok := value.(map[string]any); ok {
						active, _ := set["activeAccountId"].(string)
						if accounts, ok := set["accounts"].([]any); ok {
							for _, rawAccount := range accounts {
								account, _ := rawAccount.(map[string]any)
								if account["id"] != active || account["needsReauth"] == true {
									continue
								}
								credential, _ := account["credential"].(map[string]any)
								email, _ := credential["email"].(string)
								loggedIn[provider] = email
							}
						}
					}
				}
			}
		}
	}
	fmt.Fprintln(w, "   OAuth logins:")
	for _, provider := range providers {
		if email, ok := loggedIn[provider]; ok {
			suffix := ""
			if email != "" {
				suffix = " (" + statusMaskEmail(email) + ")"
			}
			fmt.Fprintf(w, "     %-10s ✓ logged in%s\n", provider, suffix)
		} else {
			fmt.Fprintf(w, "     %-10s ✗ not logged in\n", provider)
		}
	}
	fmt.Fprintln(w, "   Codex health: unavailable (proxy not running; live cooldown/reauth requires the management API)")
}
func statusMaskEmail(value string) string {
	at := strings.IndexByte(value, '@')
	if at <= 0 || at == len(value)-1 {
		return value
	}
	local, domain := value[:at], value[at+1:]
	if len(local) == 1 {
		return "*@" + domain
	}
	if len(local) == 2 {
		return local[:1] + "*@" + domain
	}
	return local[:1] + "***" + local[len(local)-1:] + "@" + domain
}

func statusTextConfigDiagnostic(stderr io.Writer) {
	path, err := config.Path()
	if err != nil {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil || json.Valid(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})) {
		return
	}
	backup := path + ".invalid-" + time.Now().UTC().Format("2006-01-02T15-04-05.000Z")
	if writeErr := os.WriteFile(backup, raw, 0o600); writeErr == nil {
		_ = os.Chmod(backup, 0o600)
		fmt.Fprintf(stderr, "Could not load opencodex config at %s: JSON Parse error: Expected '}'. Using default config. A backup was written to %s.\n", path, backup)
		return
	}
	fmt.Fprintf(stderr, "Could not load opencodex config at %s: JSON Parse error: Expected '}'. Using default config.\n", path)
}
