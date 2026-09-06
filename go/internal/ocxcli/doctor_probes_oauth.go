package ocxcli

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

type DoctorOAuthReliabilityInput struct {
	DataPlaneToken      string
	ServiceToken        string
	AdminToken          string
	CredentialDirectory string
	RefreshLockPath     string
}

// CollectDoctorOAuthReliability never writes a probe file or exposes a secret.
func CollectDoctorOAuthReliability(in DoctorOAuthReliabilityInput) []DoctorOAuthCheck {
	token := strings.TrimSpace(in.DataPlaneToken)
	if token == "" {
		token = strings.TrimSpace(in.ServiceToken)
	}
	checks := []DoctorOAuthCheck{}
	if token == "" {
		checks = append(checks, DoctorOAuthCheck{"OK", "No data-plane token is set, so it cannot collide with the management token."})
	} else if strings.HasPrefix(token, "ocx_admin_") || (strings.TrimSpace(in.AdminToken) != "" && token == strings.TrimSpace(in.AdminToken)) {
		checks = append(checks, DoctorOAuthCheck{"FAIL", "The data-plane secret (OPENCODEX_API_AUTH_TOKEN or the service token file) holds the management (admin) token, so the proxy fences the whole management API closed and every ocx management command fails with 503. Action: unset OPENCODEX_API_AUTH_TOKEN, replace the service token file with a distinct data-plane key, then re-run `ocx service install` and restart the proxy"})
	} else {
		checks = append(checks, DoctorOAuthCheck{"OK", "Data-plane and management credentials are distinct."})
	}
	if doctorOAuthDirectoryWritable(in.CredentialDirectory) {
		checks = append(checks, DoctorOAuthCheck{"OK", "OAuth credential storage directory is writable for atomic auth.json updates."})
	} else {
		checks = append(checks, DoctorOAuthCheck{"WARN", "OAuth credential storage directory is not writable. Action: fix permissions on OPENCODEX_HOME so ocx can create temp files and rename auth.json"})
	}
	if strings.Contains(in.RefreshLockPath, "auth.refresh.") && doctorOAuthDirectoryWritable(filepath.Dir(in.RefreshLockPath)) {
		checks = append(checks, DoctorOAuthCheck{"OK", "Token refresh single-flight is active."})
	} else {
		checks = append(checks, DoctorOAuthCheck{"WARN", "Token refresh single-flight is unavailable. Action: fix permissions on OPENCODEX_HOME so ocx can create refresh lock files"})
	}
	return checks
}

func doctorOAuthDirectoryWritable(path string) bool {
	for i := 0; path != "" && i < 9; i++ {
		info, err := os.Stat(path)
		if err == nil {
			return info.IsDir() && info.Mode().Perm()&0300 == 0300
		}
		if !errors.Is(err, os.ErrNotExist) {
			return false
		}
		next := filepath.Dir(path)
		if next == path {
			break
		}
		path = next
	}
	return false
}

func CollectDoctorOAuthReliabilityDefault() []DoctorOAuthCheck {
	dir, _ := config.Dir()
	service := doctorOAuthReadSecret(filepath.Join(dir, "service-api-token"), false)
	admin := strings.TrimSpace(os.Getenv("OPENCODEX_ADMIN_AUTH_TOKEN"))
	if admin == "" {
		admin = doctorOAuthReadSecret(filepath.Join(dir, "admin-api-token"), true)
	}
	accountHash := sha256.Sum256([]byte("probe-account"))
	return CollectDoctorOAuthReliability(DoctorOAuthReliabilityInput{os.Getenv("OPENCODEX_API_AUTH_TOKEN"), service, admin, dir, filepath.Join(dir, "auth.refresh.doctor-probe."+fmt.Sprintf("%x", accountHash[:])[:24]+".lock")})
}
func doctorOAuthReadSecret(path string, admin bool) string {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 512 {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(string(raw))
	if admin && !(strings.HasPrefix(value, "ocx_admin_") && len(value) == len("ocx_admin_")+43) {
		return ""
	}
	return value
}

type DoctorAppServerProcess struct {
	PID         int
	CommandLine string
	Executable  string
}
type DoctorCatalogCollector struct {
	List         func() ([]DoctorAppServerProcess, error)
	StartedAt    func(int) (*time.Time, error)
	CatalogMtime func() (*time.Time, error)
}

func CollectDoctorCatalogStateLive(c DoctorCatalogCollector) DoctorCatalogState {
	rows, err := c.List()
	if err != nil {
		return CollectDoctorCatalogState(DoctorCatalogProbe{EnumerationFailed: true})
	}
	probe := DoctorCatalogProbe{Starts: map[int]*time.Time{}}
	seen := map[int]bool{}
	for _, row := range rows {
		if row.PID > 0 && !seen[row.PID] && doctorIsCodexAppServer(row.CommandLine, row.Executable) {
			seen[row.PID] = true
			probe.PIDs = append(probe.PIDs, row.PID)
		}
	}
	if len(probe.PIDs) == 0 {
		return CollectDoctorCatalogState(probe)
	}
	if mtime, err := c.CatalogMtime(); err == nil {
		probe.CatalogMtime = mtime
	}
	for _, pid := range probe.PIDs {
		if start, err := c.StartedAt(pid); err == nil {
			probe.Starts[pid] = start
		}
	}
	return CollectDoctorCatalogState(probe)
}
func CollectDoctorCatalogStateDefault() DoctorCatalogState {
	return CollectDoctorCatalogStateLive(DoctorCatalogCollector{doctorListAppServers, doctorProcessStartedAt, doctorCatalogMtime})
}

func doctorIsCodexAppServer(command, executable string) bool {
	tokens := strings.Fields(strings.ReplaceAll(command, "\x00", " "))
	if len(tokens) == 0 {
		return false
	}
	base := doctorCatalogBase(tokens[0])
	if doctorCatalogBase(executable) == "codex-code-mode-host" || base == "codex-code-mode-host" {
		return true
	}
	if base == "node" || base == "node.exe" || base == "bun" || base == "bun.exe" || base == "deno" || base == "deno.exe" {
		if len(tokens) < 2 {
			return false
		}
		tokens, base = tokens[1:], doctorCatalogBase(tokens[1])
	}
	allowed := base == "codex" || base == "codex.exe" || base == "codex.cmd" || base == "codex.opencodex-real" || base == "codex.opencodex-real.cmd" || base == "codex.opencodex-real.ps1" || doctorTargetTripleCodex.MatchString(base)
	if !allowed {
		return false
	}
	for i := 1; i < len(tokens); i++ {
		token := tokens[i]
		if token == "--" {
			return false
		}
		if strings.HasPrefix(token, "-") {
			if !strings.Contains(token, "=") && doctorGlobalOptionWithValue[token] && i+1 < len(tokens) {
				i++
			}
			continue
		}
		return strings.EqualFold(token, "app-server")
	}
	return false
}

var doctorTargetTripleCodex = regexp.MustCompile(`^codex-[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)?(?:\.exe|\.cmd)?$`)
var doctorGlobalOptionWithValue = map[string]bool{
	"--enable": true, "--disable": true, "--config": true, "-c": true, "--profile": true, "-p": true,
	"--model": true, "-m": true, "--sandbox": true, "-s": true, "--ask-for-approval": true, "-a": true,
	"--local-provider": true, "--add-dir": true, "--cd": true, "-C": true, "--color": true, "--image": true,
	"-i": true, "--output-schema": true, "--output-last-message": true, "-o": true,
}

func doctorCatalogBase(value string) string {
	return strings.ToLower(filepath.Base(strings.ReplaceAll(value, "\\", "/")))
}

func doctorListAppServers() ([]DoctorAppServerProcess, error) {
	if runtime.GOOS == "linux" {
		entries, err := os.ReadDir("/proc")
		if err != nil {
			return nil, err
		}
		rows := []DoctorAppServerProcess{}
		for _, entry := range entries {
			pid, err := strconv.Atoi(entry.Name())
			if err != nil || pid <= 1 {
				continue
			}
			raw, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
			if err != nil {
				continue
			}
			tokens := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
			if len(tokens) == 0 || tokens[0] == "" {
				continue
			}
			rows = append(rows, DoctorAppServerProcess{pid, strings.Join(tokens, " "), tokens[0]})
		}
		return rows, nil
	}
	if runtime.GOOS == "windows" {
		return nil, errors.New("process enumeration unavailable")
	}
	raw, err := exec.Command("ps", "-x", "-o", "pid=,command=").Output()
	if err != nil {
		return nil, err
	}
	rows := []DoctorAppServerProcess{}
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err == nil {
			rows = append(rows, DoctorAppServerProcess{pid, strings.Join(fields[1:], " "), fields[1]})
		}
	}
	return rows, nil
}
func doctorProcessStartedAt(pid int) (*time.Time, error) {
	raw, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return nil, err
	}
	value := strings.TrimSpace(string(raw))
	if value == "" {
		return nil, nil
	}
	parsed, err := time.ParseInLocation("Mon Jan 2 15:04:05 2006", value, time.Local)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}
func doctorCatalogMtime() (*time.Time, error) {
	home := doctorCodexHome()
	path := filepath.Join(home, "opencodex-catalog.json")
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			key, value, ok := strings.Cut(line, "=")
			if ok && strings.TrimSpace(key) == "model_catalog_json" {
				value = strings.Trim(strings.TrimSpace(strings.SplitN(value, "#", 2)[0]), "\"'")
				if value != "" {
					if filepath.IsAbs(value) {
						path = value
					} else {
						path = filepath.Join(home, value)
					}
				}
				break
			}
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	mtime := info.ModTime()
	return &mtime, nil
}

type DoctorHintsInput struct {
	ProxyDown             string
	ProviderKeyDetails    []string
	CodexEnvKeyDetail     string
	CodexEnvKeyAction     string
	RebootSafe            bool
	RecommendedCommand    string
	RestoreNativeCommand  string
	AnyDrvfs              bool
	ProbeOK               bool
	NoProxy               bool
	ProbeClassification   string
	PendingFailed         bool
	PendingFailureReason  string
	BackupEntries         int
	DualInstall           bool
	EffectiveWindowsMount bool
	WindowsCodexHome      string
	AutomountRoot         string
	InteropCodexPath      string
}

func CollectDoctorHints(in DoctorHintsInput) []string {
	hints := []string{}
	if in.ProxyDown != "" {
		hints = append(hints, in.ProxyDown)
	}
	hints = append(hints, in.ProviderKeyDetails...)
	if in.CodexEnvKeyDetail != "" {
		hints = append(hints, in.CodexEnvKeyDetail+". "+in.CodexEnvKeyAction+".")
	}
	if !in.RebootSafe {
		command := in.RecommendedCommand
		if command == "" {
			command = in.RestoreNativeCommand
		}
		hints = append(hints, "Codex is pinned to the local proxy without persistent startup protection. After restart, requests can reconnect indefinitely. Run '"+command+"'.")
	}
	if in.AnyDrvfs {
		hints = append(hints, "State dir is on a Windows-mounted (/mnt) drive. Prefer the Linux home (~) under WSL for token/lock reliability.")
	}
	if !in.ProbeOK && (in.ProbeClassification == "timeout" || in.ProbeClassification == "connect_error") {
		hints = append(hints, "WHAM probe could not reach chatgpt.com. On WSL2 this is often NAT/DNS/VPN. Quota cannot prime, so auto-switch stays on unknown scores.")
		if in.NoProxy {
			hints = append(hints, "No proxy is visible to this doctor process and config.proxy is unset or unresolved. If Windows uses a proxy/VPN, set config.proxy or start ocx from a shell with HTTP(S)_PROXY.")
		}
	}
	if in.PendingFailed && in.PendingFailureReason == "busy" {
		hints = append(hints, "Backed-up history metadata is pending or its state is unreadable. The running proxy retries exact restoration automatically; to force it now, close the Codex app and run 'ocx sync'. Untracked routed history is not relabeled.")
	} else if in.PendingFailed && in.PendingFailureReason == "permission" {
		hints = append(hints, "Backed-up history metadata could not be inspected because access was denied. Fix access to the reported Codex history paths, then run 'ocx sync'; repeated retries do not repair permissions.")
	} else if in.PendingFailed {
		hints = append(hints, "The history manifest or its target is invalid or changed. Preserve both, inspect the manifest/database/rollout identity, and do not repeatedly run 'ocx sync' until the mismatch is understood. Untracked routed history is not relabeled.")
	} else if in.BackupEntries > 0 {
		hints = append(hints, "Backed-up history metadata is pending. The running proxy retries exact restoration automatically; to force it now, close the Codex app and run 'ocx sync'. Untracked routed history is not relabeled.")
	}
	if in.DualInstall && !in.EffectiveWindowsMount {
		home := in.WindowsCodexHome
		if home == "" {
			home = in.AutomountRoot + "/c/Users/<you>/.codex"
		}
		hints = append(hints, "Codex is installed on BOTH WSL and Windows. Each side keeps its own ~/.codex (logins, config, catalog are separate); ocx here manages the Linux one. To share a single home, set CODEX_HOME="+home+" in WSL (drvfs file locking is less reliable).", "localhost is one-way in WSL2 NAT mode: Windows-side codex reaches this WSL proxy via localhost (localhostForwarding, on by default), but a Windows-side proxy is NOT reachable from WSL via localhost — use networkingMode=mirrored in .wslconfig for both directions.")
	}
	if in.InteropCodexPath != "" {
		hints = append(hints, "The `codex` found on PATH is the Windows launcher reached through WSL interop; ocx will not shim it (a WSL shim breaks Windows invocations). Install codex inside WSL (npm i -g @openai/codex) or run 'ocx ensure' from Windows.")
	}
	return hints
}
