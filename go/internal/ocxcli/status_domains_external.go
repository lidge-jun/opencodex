package ocxcli

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// StatusExternalDomains is the independent projection of status evidence
// outside the proxy process. The top-level status command remains TypeScript-owned.
type StatusExternalDomains struct {
	Service       StatusExternalSummary `json:"service"`
	CodexShim     StatusExternalSummary `json:"codexShim"`
	CodexPlugins  StatusPluginsDomain   `json:"codexPlugins"`
	CodexRuntime  StatusCodexRuntime    `json:"codexRuntime"`
	CodexHome     StatusCodexHome       `json:"codexHome"`
	ClaudeDesktop StatusClaudeDesktop   `json:"claudeDesktop"`
}
type StatusExternalSummary struct {
	Summary string `json:"summary"`
}
type StatusPluginsDomain struct {
	Applicable bool   `json:"applicable"`
	Reason     string `json:"reason"`
	Summary    string `json:"summary"`
}
type StatusCodexRuntime struct {
	Path           string              `json:"path"`
	Version        *string             `json:"version"`
	Source         string              `json:"source"`
	NewerAvailable *StatusNewerRuntime `json:"newerAvailable"`
	Warning        *string             `json:"warning"`
	CatalogClamp   StatusCatalogClamp  `json:"catalogClamp"`
}
type StatusNewerRuntime struct {
	Path    string  `json:"path"`
	Version *string `json:"version"`
}
type StatusCatalogClamp struct {
	Active         bool     `json:"active"`
	RemovedEfforts []string `json:"removedEfforts"`
	RuntimeVersion *string  `json:"runtimeVersion"`
}
type StatusCodexHome struct {
	Applicable         bool    `json:"applicable"`
	Mismatch           bool    `json:"mismatch"`
	EffectiveCodexHome string  `json:"effectiveCodexHome"`
	AppCodexHome       string  `json:"appCodexHome"`
	OrcaCodexHome      *string `json:"orcaCodexHome"`
	Warning            *string `json:"warning"`
	Action             *string `json:"action"`
}
type StatusClaudeDesktop struct {
	DesiredEnabled bool                      `json:"desiredEnabled"`
	Policy         StatusClaudeDesktopPolicy `json:"policy"`
}
type StatusClaudeDesktopPolicy struct {
	OK      bool   `json:"ok"`
	Status  string `json:"status"`
	State   string `json:"state"`
	Message string `json:"message"`
	Action  string `json:"action"`
}

// CollectStatusExternalDomains mirrors TypeScript's read-only status evidence path.
func CollectStatusExternalDomains() StatusExternalDomains {
	cfg := ReadStatusConfigDiagnostics().Config
	if cfg == nil {
		cfg = &config.Config{}
	}
	return StatusExternalDomains{Service: StatusExternalSummary{statusServiceSummary()}, CodexShim: StatusExternalSummary{statusCodexShimSummary()}, CodexPlugins: statusCodexPlugins(), CodexRuntime: statusCodexRuntime(), CodexHome: statusCodexHome(), ClaudeDesktop: statusClaudeDesktop(cfg)}
}

func statusServiceSummary() string {
	if runtime.GOOS == "linux" {
		if _, err := os.Stat("/.dockerenv"); err == nil {
			return "unsupported in Docker"
		}
		if _, err := exec.LookPath("systemctl"); err != nil {
			return "unsupported: systemd not found"
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "unsupported: systemd not found"
		}
		unit := filepath.Join(home, ".config", "systemd", "user", "opencodex-proxy.service")
		log := filepath.Join(statusConfigDir(), "service.log")
		if _, err := os.Stat(unit); errors.Is(err, os.ErrNotExist) {
			return "not installed (logs: " + redactStatusPath(log) + ")"
		}
		enabled := statusSystemctl("--user", "is-enabled", "opencodex-proxy") == "enabled"
		running := statusSystemctl("--user", "is-active", "opencodex-proxy") == "active"
		if enabled && running {
			return "installed, enabled and running (systemd user; logs: " + redactStatusPath(log) + ")"
		}
		if !enabled {
			return "installed, but disabled (systemd user; logs: " + redactStatusPath(log) + ")"
		}
		return "installed, but not running (systemd user; logs: " + redactStatusPath(log) + ")"
	}
	return "unsupported on " + runtime.GOOS
}
func statusSystemctl(args ...string) string {
	out, err := exec.Command("systemctl", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
func statusConfigDir() string {
	dir, err := config.Dir()
	if err != nil {
		return ""
	}
	return dir
}

type statusShimState struct {
	Platform     string           `json:"platform"`
	WrapperPath  string           `json:"wrapperPath"`
	OriginalPath string           `json:"originalPath"`
	BackupPath   string           `json:"backupPath"`
	Wrappers     []statusShimFile `json:"wrappers"`
}
type statusShimFile struct {
	WrapperPath  string `json:"wrapperPath"`
	OriginalPath string `json:"originalPath"`
	BackupPath   string `json:"backupPath"`
}

func statusCodexShimSummary() string {
	path := filepath.Join(statusConfigDir(), "codex-shim.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "Codex autostart shim is not installed."
	}
	if err != nil {
		return statusInvalidShim(path)
	}
	var state statusShimState
	if json.Unmarshal(raw, &state) != nil || state.Platform == "" {
		return statusInvalidShim(path)
	}
	files := state.Wrappers
	if len(files) == 0 {
		files = []statusShimFile{{state.WrapperPath, state.OriginalPath, state.BackupPath}}
	}
	lines := make([]string, 0, len(files))
	for _, file := range files {
		if file.WrapperPath == "" || file.OriginalPath == "" || file.BackupPath == "" {
			return statusInvalidShim(path)
		}
		wrapper := "missing"
		if contents, readErr := os.ReadFile(file.WrapperPath); readErr == nil {
			if strings.Contains(string(contents), shimMarker) {
				wrapper = "shim present"
			} else {
				wrapper = "present but not an opencodex shim"
			}
		}
		backup := "missing"
		if _, statErr := os.Stat(file.BackupPath); statErr == nil {
			backup = "present"
		}
		lines = append(lines, "Codex autostart shim: wrapper "+wrapper+" at "+file.WrapperPath+"; original backup "+backup+" at "+file.BackupPath+".")
	}
	return strings.Join(lines, "\n")
}
func statusInvalidShim(path string) string {
	return "Codex autostart shim state is invalid or corrupt at " + path + ". Reinstall or remove the shim."
}
func statusCodexPlugins() StatusPluginsDomain {
	return StatusPluginsDomain{false, "not_windows", "not applicable (bundled-marketplace staleness is Windows-specific)"}
}

var statusVersionPattern = regexp.MustCompile("\\b(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\b")

type statusRuntimeCandidate struct{ command, source string }
type statusPersistedRuntime struct {
	Version         int     `json:"version"`
	Command         string  `json:"command"`
	Source          string  `json:"source"`
	SelectedVersion *string `json:"selectedVersion"`
	UpdatedAt       string  `json:"updatedAt"`
}
type statusPersistedClamp struct {
	Version        int      `json:"version"`
	RuntimePath    string   `json:"runtimePath"`
	RuntimeVersion *string  `json:"runtimeVersion"`
	RemovedEfforts []string `json:"removedEfforts"`
}

func statusCodexRuntime() StatusCodexRuntime {
	candidates := statusRuntimeCandidates()
	var selected *statusRuntimeCandidate
	var selectedVersion *string
	for index := range candidates {
		if version := statusCodexVersion(candidates[index].command); version != nil {
			selected, selectedVersion = &candidates[index], version
			break
		}
	}
	if selected == nil {
		warning := "No validated Codex runtime found; falling back to `codex`. Run ocx doctor for diagnosis and recovery."
		return StatusCodexRuntime{Path: "codex", Source: "fallback", Warning: &warning, CatalogClamp: StatusCatalogClamp{RemovedEfforts: []string{}}}
	}
	result := StatusCodexRuntime{Path: redactStatusPath(selected.command), Version: selectedVersion, Source: selected.source, CatalogClamp: statusCatalogClamp(*selected, selectedVersion)}
	if selected.source == "fallback" && selectedVersion == nil {
		warning := "No validated Codex runtime found; falling back to `codex`. Run ocx doctor for diagnosis and recovery."
		result.Warning = &warning
	}
	return result
}

func statusRuntimeCandidates() []statusRuntimeCandidate {
	candidates := []statusRuntimeCandidate{}
	if command := strings.TrimSpace(os.Getenv("CODEX_CLI_PATH")); command != "" {
		candidates = append(candidates, statusRuntimeCandidate{command, "environment"})
	}
	if persisted := statusLoadPersistedRuntime(); persisted != nil {
		candidates = append(candidates, statusRuntimeCandidate{persisted.Command, "configured"})
	}
	for _, command := range statusShimRuntimeCandidates() {
		candidates = append(candidates, statusRuntimeCandidate{command, "shim"})
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir != "" {
			candidates = append(candidates, statusRuntimeCandidate{filepath.Join(dir, "codex"), "path"})
		}
	}
	return append(candidates, statusRuntimeCandidate{"codex", "fallback"})
}

func statusLoadPersistedRuntime() *statusPersistedRuntime {
	raw, err := os.ReadFile(filepath.Join(statusConfigDir(), "codex-runtime.json"))
	if err != nil {
		return nil
	}
	var state statusPersistedRuntime
	if json.Unmarshal(raw, &state) != nil || state.Version != 1 || strings.TrimSpace(state.Command) == "" || state.UpdatedAt == "" {
		return nil
	}
	if state.Source != "environment" && state.Source != "configured" && state.Source != "shim" && state.Source != "path" && state.Source != "fallback" {
		return nil
	}
	return &state
}

func statusShimRuntimeCandidates() []string {
	raw, err := os.ReadFile(filepath.Join(statusConfigDir(), "codex-shim.json"))
	if err != nil {
		return nil
	}
	var state statusShimState
	if json.Unmarshal(raw, &state) != nil {
		return nil
	}
	files := state.Wrappers
	if len(files) == 0 {
		files = []statusShimFile{{state.WrapperPath, state.OriginalPath, state.BackupPath}}
	}
	seen, candidates := map[string]bool{}, []string{}
	for _, file := range files {
		for _, path := range []string{file.BackupPath, file.OriginalPath, file.WrapperPath} {
			if path != "" && !seen[path] {
				seen[path] = true
				candidates = append(candidates, path)
			}
		}
	}
	return candidates
}

func statusCatalogClamp(selected statusRuntimeCandidate, version *string) StatusCatalogClamp {
	clamp := StatusCatalogClamp{RemovedEfforts: []string{}}
	raw, err := os.ReadFile(filepath.Join(statusConfigDir(), "codex-runtime-clamp.json"))
	if err != nil {
		return clamp
	}
	var persisted statusPersistedClamp
	if json.Unmarshal(raw, &persisted) != nil || persisted.Version != 1 || len(persisted.RemovedEfforts) == 0 {
		return clamp
	}
	active := strings.EqualFold(strings.TrimSpace(persisted.RuntimePath), strings.TrimSpace(selected.command)) || (persisted.RuntimeVersion != nil && version != nil && *persisted.RuntimeVersion == *version)
	if !active {
		return clamp
	}
	clamp.Active, clamp.RemovedEfforts, clamp.RuntimeVersion = true, append([]string(nil), persisted.RemovedEfforts...), persisted.RuntimeVersion
	return clamp
}

func statusCodexVersion(command string) *string {
	if command == "" {
		return nil
	}
	out, err := exec.Command(command, "--version").Output()
	if err != nil {
		return nil
	}
	match := statusVersionPattern.FindStringSubmatch(strings.TrimSpace(string(out)))
	if len(match) < 2 {
		return nil
	}
	value := match[1]
	return &value
}
func statusCodexHome() StatusCodexHome {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	app := filepath.Join(home, ".codex")
	effective := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if effective == "" {
		effective = app
	} else if resolved, resolveErr := filepath.Abs(effective); resolveErr == nil {
		effective = resolved
	}
	return StatusCodexHome{EffectiveCodexHome: redactStatusPath(effective), AppCodexHome: redactStatusPath(app)}
}
func statusClaudeDesktop(cfg *config.Config) StatusClaudeDesktop {
	desired := true
	if integrations, ok := cfg.Raw["clientIntegrations"].(map[string]any); ok && integrations["claude-desktop"] == false {
		desired = false
	}
	return StatusClaudeDesktop{desired, StatusClaudeDesktopPolicy{true, "ok", "not_applicable", "Windows managed Claude policy is not applicable on this platform.", "No action required."}}
}
func redactStatusPath(path string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(path, home+string(os.PathSeparator)) {
		if strings.HasPrefix(home, "/home/") {
			return "/home/[USER]" + strings.TrimPrefix(path, home)
		}
		if strings.HasPrefix(home, "/Users/") {
			return "/Users/[USER]" + strings.TrimPrefix(path, home)
		}
	}
	return path
}
