package ocxcli

// Read-only doctor primitives retained separately until doctor ownership moves
// from TypeScript. Each formatter preserves the human report's exact wording.
import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const doctorWHAMURL = "https://chatgpt.com/backend-api/wham/usage"

var execLookPath = exec.LookPath

type DoctorOrcaHome struct {
	Applicable, Mismatch                                             bool
	EffectiveCodexHome, AppCodexHome, OrcaCodexHome, Warning, Action string
}

func CollectDoctorOrcaHome() DoctorOrcaHome {
	home, _ := os.UserHomeDir()
	app, effective := filepath.Join(home, ".codex"), doctorCodexHome()
	orca, explicit := strings.TrimSpace(os.Getenv("ORCA_CODEX_HOME")), strings.TrimSpace(os.Getenv("CODEX_HOME"))
	d := DoctorOrcaHome{EffectiveCodexHome: effective, AppCodexHome: app, OrcaCodexHome: orca}
	if runtime.GOOS != "windows" || explicit == "" || orca == "" {
		return d
	}
	normalize := func(v string) string {
		return strings.ToLower(strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(v), "/", "\\"), "\\"))
	}
	e, o, a := normalize(effective), normalize(orca), normalize(app)
	d.Applicable = e == o && strings.HasSuffix(o, "\\orca\\codex-runtime-home\\home")
	d.Mismatch = d.Applicable && e != a
	if d.Mismatch {
		d.Warning = fmt.Sprintf("CODEX_HOME targets Orca's runtime home (%s), while the Windows ChatGPT/Codex app uses %s; OpenCodex injection will not reach that app.", effective, app)
		d.Action = "If a service was installed from Orca, run 'ocx service uninstall' in that original Orca shell first. Then in Command Prompt run set \"ORCA_CODEX_HOME=\" and set \"CODEX_HOME=%USERPROFILE%\\.codex\"; or in PowerShell run Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'. Rerun the command, then reinstall with 'ocx service install'."
	}
	return d
}
func FormatDoctorOrcaHome(d DoctorOrcaHome) []string {
	state := "ok  "
	if d.Mismatch {
		state = "!! "
	}
	lines := []string{"Codex app home targeting", "  " + state + "Effective Codex home: " + d.EffectiveCodexHome}
	if d.Mismatch {
		return append(lines, "  !!  "+d.Warning, "      Action: "+d.Action)
	}
	return append(lines, "      No Orca-owned CODEX_HOME mismatch detected.")
}

type DoctorRestartSafety struct {
	RebootSafe      bool
	Summary, Detail string
}

func CollectDoctorRestartSafety(d StatusStartupDomain) DoctorRestartSafety {
	return DoctorRestartSafety{d.RebootSafe, statusStartupSummary(d), "routing=" + d.RoutingKind + ", service=" + statusServiceState(d) + ", shim=" + statusShimStateText(d)}
}
func FormatDoctorRestartSafety(d DoctorRestartSafety) []string {
	state := "!!  "
	if d.RebootSafe {
		state = "ok  "
	}
	return []string{"Codex restart safety", "  " + state + d.Summary, "       " + d.Detail}
}

type DoctorRuntimeSelection struct {
	Path, Version, Source, Warning, NewerPath, NewerVersion string
	Clamp                                                   []string
}

func CollectDoctorRuntimeSelection() DoctorRuntimeSelection {
	r := statusCodexRuntime()
	d := DoctorRuntimeSelection{Path: r.Path, Source: r.Source, Clamp: append([]string(nil), r.CatalogClamp.RemovedEfforts...)}
	if r.Version != nil {
		d.Version = *r.Version
	}
	if r.Warning != nil {
		d.Warning = *r.Warning
	}
	if r.NewerAvailable != nil {
		d.NewerPath = r.NewerAvailable.Path
		if r.NewerAvailable.Version != nil {
			d.NewerVersion = *r.NewerAvailable.Version
		}
	}
	return d
}
func FormatDoctorRuntimeSelection(d DoctorRuntimeSelection) []string {
	v := d.Version
	if v == "" {
		v = "unknown"
	}
	lines := []string{"Codex runtime selection", fmt.Sprintf("  ok  Selected runtime: %s (%s, source=%s)", d.Path, v, d.Source)}
	if d.Warning != "" {
		lines = append(lines, "  !!  "+d.Warning)
	}
	if d.NewerPath != "" {
		v := d.NewerVersion
		if v == "" {
			v = "unknown"
		}
		lines = append(lines, "  !!  Multiple Codex installations found.", fmt.Sprintf("  ok  Newer usable runtime found: %s (%s)", d.NewerPath, v), "       Suggested: set CODEX_CLI_PATH to the desired binary and run ocx sync.", "       Optional: ocx doctor --fix-codex-runtime")
	}
	if len(d.Clamp) > 0 {
		lines = append(lines, "  !!  "+strings.Join(d.Clamp, " and ")+" were removed during catalog sync.", "       Suggested: set CODEX_CLI_PATH to a newer Codex binary and run ocx sync.")
	}
	return lines
}

type DoctorLiveProxy struct {
	Running          bool
	PID, Port        int
	Version, Warning string
}

func FormatDoctorLiveProxyVersion(d DoctorLiveProxy, cliVersion string) []string {
	if !d.Running || d.Version == "" {
		return nil
	}
	if d.Warning != "" {
		return []string{"!! " + d.Warning}
	}
	return []string{"ok ocx " + cliVersion + " matches the running proxy"}
}

type DoctorEagerRelay struct {
	Enabled bool
	Reason  string
}
type DoctorServiceMemoryData struct {
	PID                                                  int
	BunVersion, Platform                                 string
	RSS, HeapUsed, External, ArrayBuffers, ObservedBytes int64
	ObservedMetric, StreamMode                           string
	WatchdogThreshold                                    int64
	WatchdogLastWarn                                     *time.Time
	JSCHeap                                              *int64
	EagerRelay                                           *DoctorEagerRelay
	BunRuntimeSource                                     string
}
type DoctorServiceMemoryReport struct {
	Status, Error string
	Data          DoctorServiceMemoryData
}

func doctorMB3(n int64) string { return fmt.Sprintf("%dMB", (n+1024*1024/2)/(1024*1024)) }
func FormatDoctorServiceMemory(r DoctorServiceMemoryReport, bun string) []string {
	lines := []string{fmt.Sprintf("  --     doctor process Bun %s (this is NOT the service process)", bun)}
	if r.Status == "unauthorized" {
		return append(lines, "  --     local diagnostic capability unavailable — restart the running proxy with this OpenCodex version")
	}
	if r.Status != "ok" {
		return append(lines, fmt.Sprintf("  --     proxy not reachable (not running?) [%s]", r.Error))
	}
	d := r.Data
	lines = append(lines, fmt.Sprintf("  ok     service pid %d: Bun %s on %s", d.PID, d.BunVersion, d.Platform), fmt.Sprintf("         rss=%s, external=%s, arrayBuffers=%s, heapUsed=%s", doctorMB3(d.RSS), doctorMB3(d.External), doctorMB3(d.ArrayBuffers), doctorMB3(d.HeapUsed)))
	if d.JSCHeap != nil {
		lines[len(lines)-1] += ", jscHeap=" + doctorMB3(*d.JSCHeap)
	}
	observed, metric := d.ObservedBytes, d.ObservedMetric
	if observed == 0 {
		observed, metric = d.RSS, "rss"
		if d.External > observed {
			observed, metric = d.External, "external"
		}
		if d.ArrayBuffers > observed {
			observed, metric = d.ArrayBuffers, "arrayBuffers"
		}
	}
	lines = append(lines, fmt.Sprintf("         observed=%s (%s)", doctorMB3(observed), metric))
	mode := d.StreamMode
	if mode == "" {
		mode = "auto"
	}
	if d.EagerRelay != nil {
		on := "off"
		if d.EagerRelay.Enabled {
			on = "on"
		}
		mode += fmt.Sprintf(" (eager relay: %s, %s)", on, d.EagerRelay.Reason)
	}
	lines = append(lines, "         streamMode="+mode)
	if d.WatchdogThreshold > 0 {
		suffix := ", no warnings"
		if d.WatchdogLastWarn != nil {
			suffix = ", last warn " + d.WatchdogLastWarn.UTC().Format(time.RFC3339Nano)
		}
		lines = append(lines, "         watchdog threshold="+doctorMB3(d.WatchdogThreshold)+suffix)
	}
	threshold := d.WatchdogThreshold
	if threshold == 0 {
		threshold = 4 * 1024 * 1024 * 1024
	}
	if observed < threshold {
		return append(lines, "         memory usage looks normal")
	}
	if metric != "rss" {
		return append(lines, "  !!     high observed memory via "+metric+"; Windows RSS/working-set counters may be blind. See docs: troubleshooting/windows-memory")
	}
	js := d.HeapUsed
	if d.JSCHeap != nil && *d.JSCHeap > js {
		js = *d.JSCHeap
	}
	if d.RSS > 0 && js*4 < d.RSS {
		return append(lines, "  !!     high RSS with a small JS heap — native-side growth (Bun runtime buffers/handles). See docs: troubleshooting/windows-memory")
	}
	if d.RSS > 0 && js*2 >= d.RSS {
		return append(lines, "  !!     high RSS with large JS/JSC counters — possible JS-side retention; compare responseState/external samples before filing an app leak")
	}
	return append(lines, "  !!     high RSS, indeterminate split — capture two doctor runs over time to see the trend")
}

type DoctorWhamResult struct {
	OK             bool
	Status         *int
	Duration       time.Duration
	Classification string
	Authenticated  bool
}

func ProbeDoctorWHAM(ctx context.Context, client *http.Client, token, accountID string) DoctorWhamResult {
	start := time.Now()
	if client == nil {
		client = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, doctorWHAMURL, nil)
	if err != nil {
		return DoctorWhamResult{Duration: time.Since(start), Classification: "connect_error"}
	}
	auth := strings.TrimSpace(token) != ""
	if auth {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("ChatGPT-Account-Id", accountID)
	}
	res, err := client.Do(req)
	duration := time.Since(start)
	if err != nil {
		kind := "connect_error"
		if ctx.Err() != nil {
			kind = "timeout"
		}
		return DoctorWhamResult{Duration: duration, Classification: kind, Authenticated: auth}
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	status := res.StatusCode
	ok := status >= 200 && status < 300
	kind := "http_" + strconv.Itoa(status)
	if ok {
		kind = "ok"
	}
	return DoctorWhamResult{ok, &status, duration, kind, auth}
}
func FormatDoctorWHAM(r DoctorWhamResult) []string {
	state := "-- "
	if r.OK {
		state = "ok "
	}
	detail := "error=" + r.Classification
	if r.Status != nil {
		detail = "status=" + strconv.Itoa(*r.Status)
	}
	auth := "unauthenticated"
	if r.Authenticated {
		auth = "authenticated"
	}
	return []string{"WHAM reachability", "  " + state + doctorWHAMURL, fmt.Sprintf("       %s, %dms, %s", detail, r.Duration.Milliseconds(), auth)}
}

// DoctorWslDeps makes the WSL probe testable without requiring WSL.  The
// production collector supplies the real environment and filesystem readers.
type DoctorWslDeps struct {
	WSL, LinuxConfigExists                       bool
	AutomountRoot, EffectiveCodexHome, PathValue string
	WindowsHomes                                 []string
	CodexPath                                    string
}
type DoctorWslDiagnostic struct {
	WSL, LinuxCodexConfigured, EffectiveIsWindowsMount, DualInstall bool
	AutomountRoot, EffectiveCodexHome, InteropCodexOnPath           string
	WindowsCodexHomes                                               []string
}

// CollectCurrentDoctorWslDualInstall is the production read-only collector.
// It never creates Windows profile directories and treats unreadable mounts as
// an empty discovery result, the same conservative downgrade as TypeScript.
func CollectCurrentDoctorWslDualInstall() DoctorWslDiagnostic {
	if runtime.GOOS != "linux" {
		return CollectDoctorWslDualInstall(DoctorWslDeps{})
	}
	proc, _ := os.ReadFile("/proc/version")
	wsl := strings.TrimSpace(os.Getenv("WSL_DISTRO_NAME")) != "" || strings.TrimSpace(os.Getenv("WSL_INTEROP")) != "" || strings.Contains(strings.ToLower(string(proc)), "microsoft") || strings.Contains(strings.ToLower(string(proc)), "wsl")
	home, _ := os.UserHomeDir()
	linuxConfig := false
	if home != "" {
		_, err := os.Stat(filepath.Join(home, ".codex", "config.toml"))
		linuxConfig = err == nil
	}
	root := "/mnt"
	if raw, err := os.ReadFile("/etc/wsl.conf"); err == nil {
		inAutomount := false
		for _, rawLine := range strings.Split(string(raw), "\n") {
			line := strings.TrimSpace(strings.SplitN(strings.SplitN(rawLine, "#", 2)[0], ";", 2)[0])
			if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
				inAutomount = strings.EqualFold(strings.TrimSpace(line[1:len(line)-1]), "automount")
				continue
			}
			if inAutomount {
				if key, value, ok := strings.Cut(line, "="); ok && strings.EqualFold(strings.TrimSpace(key), "root") {
					candidate := strings.Trim(strings.TrimSpace(value), "\"'")
					if strings.HasPrefix(candidate, "/") {
						root = strings.TrimRight(candidate, "/")
					}
				}
			}
		}
	}
	homes := []string{}
	users := filepath.Join(root, "c", "Users")
	if entries, err := os.ReadDir(users); err == nil {
		for _, entry := range entries {
			if entry.Name() == "Default" || entry.Name() == "Default User" || entry.Name() == "Public" || entry.Name() == "All Users" {
				continue
			}
			candidate := filepath.Join(users, entry.Name(), ".codex")
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				if _, err := os.Stat(filepath.Join(candidate, "config.toml")); err == nil {
					homes = append(homes, candidate)
				}
			}
		}
	}
	codexPath, _ := os.Executable()
	if path, err := execLookPath("codex"); err == nil {
		codexPath = path
	}
	return CollectDoctorWslDualInstall(DoctorWslDeps{WSL: wsl, LinuxConfigExists: linuxConfig, AutomountRoot: root, EffectiveCodexHome: doctorCodexHome(), WindowsHomes: homes, CodexPath: codexPath})
}

func CollectDoctorWslDualInstall(deps DoctorWslDeps) DoctorWslDiagnostic {
	root := strings.TrimRight(deps.AutomountRoot, "/")
	if root == "" {
		root = "/mnt"
	}
	d := DoctorWslDiagnostic{WSL: deps.WSL, AutomountRoot: root, EffectiveCodexHome: deps.EffectiveCodexHome, LinuxCodexConfigured: deps.LinuxConfigExists, WindowsCodexHomes: append([]string(nil), deps.WindowsHomes...)}
	if !d.WSL {
		return d
	}
	prefix := root + "/"
	d.EffectiveIsWindowsMount = strings.HasPrefix(d.EffectiveCodexHome, prefix)
	d.DualInstall = d.LinuxCodexConfigured && len(d.WindowsCodexHomes) > 0
	if strings.HasPrefix(deps.CodexPath, prefix) {
		d.InteropCodexOnPath = deps.CodexPath
	}
	return d
}
func FormatDoctorWslDualInstall(d DoctorWslDiagnostic) []string {
	if !d.WSL {
		return nil
	}
	linux := "-- "
	if d.LinuxCodexConfigured {
		linux = "ok "
	}
	lines := []string{"WSL Codex installs", "  " + linux + "Linux ~/.codex/config.toml"}
	if len(d.WindowsCodexHomes) == 0 {
		lines = append(lines, "  --  no Windows-profile .codex detected under /mnt/c/Users")
	} else {
		for _, home := range d.WindowsCodexHomes {
			lines = append(lines, "  ok  Windows "+home)
		}
	}
	effective := "      effective CODEX_HOME: " + d.EffectiveCodexHome
	if d.EffectiveIsWindowsMount {
		effective += " (Windows mount)"
	}
	lines = append(lines, effective)
	if d.InteropCodexOnPath != "" {
		lines = append(lines, "  --  codex on PATH is the Windows launcher via interop: "+d.InteropCodexOnPath)
	}
	return lines
}

type DoctorProjectConfigWarning struct{ Path, Issue, Bypass string }

func CollectDoctorProjectConfigs(cwd string) []DoctorProjectConfigWarning {
	var rows []DoctorProjectConfigWarning
	seen := map[string]bool{}
	for i := 0; i < 12; i++ {
		p := filepath.Join(cwd, ".codex", "config.toml")
		if !seen[p] {
			seen[p] = true
			if raw, err := os.ReadFile(p); err == nil {
				provider := doctorTomlRoot3(string(raw), "model_provider")
				if provider != "" && provider != "opencodex" && provider != "openai" {
					rows = append(rows, DoctorProjectConfigWarning{p, "model_provider=\"" + provider + "\"", "Overrides OpenCodex — Codex uses " + provider + " for this repo instead of the proxy (~/.codex/config.toml)."})
				}
			}
		}
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}
	return rows
}
func doctorTomlRoot3(text, key string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			break
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 && strings.TrimSpace(parts[0]) == key {
			return strings.Trim(strings.TrimSpace(strings.SplitN(parts[1], "#", 2)[0]), "\\\"'")
		}
	}
	return ""
}
func FormatDoctorProjectConfigs(rows []DoctorProjectConfigWarning) []string {
	lines := []string{"Project Codex configs"}
	if len(rows) == 0 {
		return append(lines, "  ok     no project-local provider bypass detected")
	}
	for _, r := range rows {
		lines = append(lines, "  --     "+r.Path+" — "+r.Issue, "         "+r.Bypass)
	}
	return append(lines, "       fix: remove those entries so OpenCodex proxy routing applies in this project")
}

func CollectDoctorAgentRoles(codexHome string) []string {
	entries, err := os.ReadDir(filepath.Join(codexHome, "agents"))
	if err != nil {
		return nil
	}
	roles := []string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".toml") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(codexHome, "agents", name))
		if err == nil && doctorHasTOMLKey3(string(raw), "model_fallback") {
			roles = append(roles, strings.TrimSuffix(name, ".toml"))
		}
	}
	sort.Strings(roles)
	return roles
}
func doctorHasTOMLKey3(text, key string) bool {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 && strings.Trim(strings.TrimSpace(parts[0]), "\\\"'") == key {
			return true
		}
	}
	return false
}
func FormatDoctorAgentRoles(roles []string) []string {
	lines := []string{"Codex agent role files"}
	if len(roles) == 0 {
		return append(lines, "  ok     no per-role model_fallback fields in $CODEX_HOME/agents/*.toml")
	}
	plural, verb := "s", "contain"
	if len(roles) == 1 {
		plural, verb = "", "contains"
	}
	return append(lines, fmt.Sprintf("  [WARN] %d agent role file%s %s `model_fallback`: %s", len(roles), plural, verb, strings.Join(roles, ", ")), "        Codex >= 0.146 rejects that field as unknown and skips the whole role. Move the chains to opencodex config `subagentModelFallbackByModel` (keyed by primary model) and remove the field from the TOML files.")
}

type DoctorCatalogState struct {
	State string
	PIDs  []int
}

func FormatDoctorCatalogState(d DoctorCatalogState) []string {
	switch d.State {
	case "stale":
		ids := make([]string, len(d.PIDs))
		for i, p := range d.PIDs {
			ids[i] = strconv.Itoa(p)
		}
		return []string{"  [WARN] Codex app-server (PID(s): " + strings.Join(ids, ", ") + ") started before the on-disk catalog changed; its in-memory model list disagrees with ocx. Action: restart Codex (or run `ocx sync --restart-codex`; on Windows the desktop app may need `ocx sync --restart-desktop-app`)"}
	case "unknown":
		return []string{"  [WARN] Could not verify whether the running Codex app-server's model catalog is current (start time or catalog unreadable). Action: if the model list looks stale, restart Codex"}
	case "fresh":
		return []string{"  [OK] Codex app-server model catalog is current with the on-disk catalog."}
	default:
		return nil
	}
}

type DoctorOAuthCheck struct{ Level, Message string }

func CollectDoctorOAuthChecks() []DoctorOAuthCheck {
	dir := statusConfigDir()
	info, err := os.Stat(dir)
	if dir == "" || err != nil || !info.IsDir() {
		return []DoctorOAuthCheck{{"WARN", "OAuth credential storage directory is not writable. Action: fix permissions on OPENCODEX_HOME so ocx can create temp files and rename auth.json"}}
	}
	return []DoctorOAuthCheck{{"OK", "OAuth credential storage directory is writable for atomic auth.json updates."}, {"OK", "Token refresh single-flight is active."}, {"OK", "Codex forward path uses pass-through client metadata (build-time invariant; not a runtime scan)."}}
}
func FormatDoctorOAuthChecks(rows []DoctorOAuthCheck) []string {
	lines := []string{"OAuth reliability"}
	for _, r := range rows {
		lines = append(lines, "  ["+r.Level+"] "+r.Message)
	}
	return lines
}

type DoctorHistoryState struct{ Namespace, Restore string }

func FormatDoctorHistoryState(d DoctorHistoryState) []string {
	lines := []string{"Codex history metadata restore"}
	switch d.Namespace {
	case "missing":
		lines = append(lines, "  ok     history coordinator namespace not created yet (no history operation has run)")
	case "refused":
		lines = append(lines, "  --     history coordinator namespace refused: "+d.Restore)
	default:
		lines = append(lines, "  ok     history coordinator namespace resolves")
	}
	if d.Restore != "" && d.Namespace != "refused" {
		lines = append(lines, d.Restore)
	}
	return lines
}
