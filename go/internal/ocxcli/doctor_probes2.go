package ocxcli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

// DoctorConfiguredProxy is the secret-free effective config.proxy diagnostic.
type DoctorConfiguredProxy struct {
	Present, Configured bool
	Source, Detail      string
}

// DoctorEnvReferenceName accepts the only two config indirections doctor supports.
func DoctorEnvReferenceName(value string) string {
	if len(value) >= 4 && strings.HasPrefix(value, "$"+"{") && strings.HasSuffix(value, "}") {
		name := value[2 : len(value)-1]
		if doctorEnvName(name) {
			return name
		}
	}
	if len(value) >= 2 && value[0] == '$' {
		name := value[1:]
		if doctorEnvName(name) {
			return name
		}
	}
	return ""
}

func doctorEnvName(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// CollectDoctorConfiguredProxy mirrors collectConfiguredProxy without exposing a proxy URL.
func CollectDoctorConfiguredProxy(diagnostic StatusConfigDiagnostic, env map[string]string) DoctorConfiguredProxy {
	if diagnostic.Error != nil {
		return DoctorConfiguredProxy{Source: diagnostic.Source, Detail: "config unreadable (" + *diagnostic.Error + ")"}
	}
	raw := ""
	if diagnostic.Config != nil {
		raw, _ = diagnostic.Config.Raw["proxy"].(string)
		raw = strings.TrimSpace(raw)
	}
	if raw == "" {
		return DoctorConfiguredProxy{Source: diagnostic.Source, Detail: "not configured"}
	}
	name := DoctorEnvReferenceName(raw)
	resolved := raw
	if strings.HasPrefix(raw, "$") {
		if name != "" {
			resolved = env[name]
		} else {
			resolved = env[raw[1:]]
		}
	}
	if strings.TrimSpace(resolved) != "" {
		detail := "value hidden"
		if name != "" {
			detail = "env reference " + name + " resolved"
		}
		return DoctorConfiguredProxy{Present: true, Configured: true, Source: diagnostic.Source, Detail: detail}
	}
	detail := "empty after resolution"
	if name != "" {
		detail = "env reference " + name + " is unset"
	}
	return DoctorConfiguredProxy{Configured: true, Source: diagnostic.Source, Detail: detail}
}

func FormatDoctorConfiguredProxy(d DoctorConfiguredProxy) []string {
	state := "unset   "
	if d.Present {
		state = "set    "
	}
	return []string{"Configured proxy (value hidden)", "  " + state + "config.proxy (" + d.Source + "; " + d.Detail + ")"}
}

type DoctorProviderAPIKeyDiagnostic struct{ Provider, EnvName, Detail string }

// CollectDoctorProviderAPIKeys reports missing env references only. It never returns key values.
func CollectDoctorProviderAPIKeys(raw any, env map[string]string) []DoctorProviderAPIKeyDiagnostic {
	providers, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	rows := []DoctorProviderAPIKeyDiagnostic{}
	for provider, value := range providers {
		entry, ok := value.(map[string]any)
		if !ok {
			continue
		}
		mode, _ := entry["authMode"].(string)
		key, _ := entry["apiKey"].(string)
		if mode != "key" {
			continue
		}
		name := DoctorEnvReferenceName(strings.TrimSpace(key))
		if name == "" || strings.TrimSpace(env[name]) != "" {
			continue
		}
		rows = append(rows, DoctorProviderAPIKeyDiagnostic{provider, name, "provider " + provider + ": env reference " + name + " is unset or empty in this process"})
	}
	return rows
}

// CollectDoctorProviderAPIKeysOrdered retains JavaScript Object.entries order
// for a config file. Use this on an on-disk diagnostic; the map form above is
// retained as a narrow pure-input seam.
func CollectDoctorProviderAPIKeysOrdered(providers *config.OrderedValue, env map[string]string) []DoctorProviderAPIKeyDiagnostic {
	rows := []DoctorProviderAPIKeyDiagnostic{}
	for _, provider := range providers.ECMAScriptEntries() {
		mode, _ := provider.Value.Find("authMode").StringValue()
		key, _ := provider.Value.Find("apiKey").StringValue()
		if mode != "key" {
			continue
		}
		name := DoctorEnvReferenceName(strings.TrimSpace(key))
		if name == "" || strings.TrimSpace(env[name]) != "" {
			continue
		}
		rows = append(rows, DoctorProviderAPIKeyDiagnostic{provider.Key, name, "provider " + provider.Key + ": env reference " + name + " is unset or empty in this process"})
	}
	return rows
}

func FormatDoctorProviderAPIKeys(rows []DoctorProviderAPIKeyDiagnostic) []string {
	lines := []string{"Provider API keys (value hidden)"}
	if len(rows) == 0 {
		return append(lines, "  ok     no empty env-referenced provider keys detected in this process")
	}
	for _, row := range rows {
		lines = append(lines, "  !!     "+row.Detail)
	}
	return lines
}

type DoctorShimDiagnostic struct{ Installed, Healthy bool }
type DoctorCodexEnvKeyReadiness struct{ EnvName, ShimState, Detail, Action string }

// CollectDoctorCodexEnvKeyReadiness mirrors the active model provider's launch-time token check.
func CollectDoctorCodexEnvKeyReadiness(configText string, env map[string]string, shim DoctorShimDiagnostic, serviceTokenPresent bool) *DoctorCodexEnvKeyReadiness {
	if doctorTOMLRootString(configText, "model_provider") != "opencodex" {
		return nil
	}
	envName := doctorTOMLProviderString(configText, "opencodex", "env_key")
	if envName == "" || strings.TrimSpace(env[envName]) != "" || shim.Healthy || !serviceTokenPresent {
		return nil
	}
	state := "missing"
	if shim.Installed {
		state = "unhealthy"
	}
	return &DoctorCodexEnvKeyReadiness{
		EnvName: envName, ShimState: state,
		Detail: "Codex uses env_key " + envName + ", but that variable is unset and the OpenCodex shim is " + state + "; the service token file exists but plain Codex does not load it",
		Action: "Run 'ocx codex-shim install' to repair launch-time token injection, or export " + envName + " in the process that starts Codex",
	}
}

var doctorTOMLStringPattern = regexp.MustCompile("^\\s*(?:[A-Za-z0-9_-]+|\\\"[^\\\"]+\\\"|'[^']+')\\s*=\\s*(\\\"(?:\\\\\\\\.|[^\\\"\\\\\\\\])*\\\"|'[^']*')\\s*(?:#.*)?$")

func doctorTOMLValue(line, key string) string {
	match := doctorTOMLStringPattern.FindStringSubmatch(line)
	if len(match) != 2 {
		return ""
	}
	left := strings.Trim(strings.TrimSpace(strings.SplitN(line, "=", 2)[0]), "\"'")
	if left != key {
		return ""
	}
	return strings.Trim(strings.TrimSpace(match[1]), "\"'")
}

func doctorTOMLRootString(content, key string) string {
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "[") {
			break
		}
		if value := doctorTOMLValue(line, key); value != "" {
			return value
		}
	}
	return ""
}

func doctorTOMLProviderString(content, provider, key string) string {
	inTable := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			table := strings.Trim(strings.SplitN(trimmed, "#", 2)[0], " []\t")
			inTable = table == "model_providers."+provider || table == "model_providers.\""+provider+"\"" || table == "model_providers.'"+provider+"'"
			continue
		}
		if inTable {
			if value := doctorTOMLValue(line, key); value != "" {
				return value
			}
		}
	}
	return ""
}

func FormatDoctorCodexEnvKeyReadiness(row *DoctorCodexEnvKeyReadiness) []string {
	lines := []string{"Codex env_key launch readiness"}
	if row == nil {
		return append(lines, "  ok     no broken OpenCodex env_key launch path detected")
	}
	return append(lines, "  !!     "+row.Detail, "         Action: "+row.Action)
}

const doctorResponseTempGrace = 15 * time.Minute
const doctorResponseTempMaxEntries = 4096
const doctorResponseTempMaxCleanups = 4096

var doctorResponseTempName = regexp.MustCompile("^responses-state\\.json\\.ocx\\.([0-9]+)\\.([0-9]+)\\.tmp$")

type DoctorResponseTempResult struct {
	Matched, Removed, Failed, BytesRemoved, Eligible, EligibleBytes int64
	Truncated                                                       bool
}

// InspectDoctorResponseTemps reports eligible abandoned response-state writes in OPENCODEX_HOME.
func InspectDoctorResponseTemps() DoctorResponseTempResult { return collectDoctorResponseTemps(false) }

// ReclaimDoctorResponseTemps explicitly removes eligible files; doctor command ownership remains TypeScript-side.
func ReclaimDoctorResponseTemps() DoctorResponseTempResult { return collectDoctorResponseTemps(true) }

func collectDoctorResponseTemps(reclaim bool) DoctorResponseTempResult {
	result := DoctorResponseTempResult{}
	dir, err := config.Dir()
	if err != nil {
		return result
	}
	now := time.Now()
	bootTime := doctorBootTime(now)
	seen := map[string]struct{}{}
	scanned := 0
	for _, sweepDir := range doctorResponseTempDirectories(dir) {
		entries, readErr := os.ReadDir(sweepDir)
		if readErr != nil {
			continue
		}
		for _, entry := range entries {
			path := filepath.Join(sweepDir, entry.Name())
			if _, duplicate := seen[path]; duplicate {
				continue
			}
			seen[path] = struct{}{}
			scanned++
			if scanned > doctorResponseTempMaxEntries {
				result.Truncated = true
				return result
			}
			match := doctorResponseTempName.FindStringSubmatch(entry.Name())
			if len(match) != 3 {
				continue
			}
			result.Matched++
			pid, pidErr := strconv.Atoi(match[1])
			sequence, seqErr := strconv.Atoi(match[2])
			if pidErr != nil || seqErr != nil || pid <= 0 || sequence <= 0 {
				continue
			}
			info, statErr := os.Lstat(path)
			if statErr != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) < doctorResponseTempGrace || pid == os.Getpid() {
				continue
			}
			predatesBoot := !bootTime.IsZero() && info.ModTime().Before(bootTime.Add(-time.Minute))
			if !predatesBoot && doctorProcessAlive(pid) {
				continue
			}
			result.Eligible++
			result.EligibleBytes += info.Size()
			if !reclaim {
				continue
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				result.Failed++
				continue
			}
			result.Removed++
			result.BytesRemoved += info.Size()
			if result.Removed+result.Failed >= doctorResponseTempMaxCleanups {
				result.Truncated = true
				return result
			}
		}
	}
	return result
}

func doctorResponseTempDirectories(literal string) []string {
	directories := []string{literal}
	if resolved, err := filepath.EvalSymlinks(filepath.Join(literal, "responses-state.json")); err == nil && filepath.Dir(resolved) != literal {
		directories = append(directories, filepath.Dir(resolved))
	} else if resolved, err := filepath.EvalSymlinks(literal); err == nil && resolved != literal {
		directories = append(directories, resolved)
	}
	return directories
}

func doctorMB(bytes int64) string { return fmt.Sprintf("%dMB", (bytes+1024*1024/2)/(1024*1024)) }

func FormatDoctorResponseTemps(result DoctorResponseTempResult, reclaimed bool) []string {
	const clean = "  ok  No abandoned response-state temp files."
	if reclaimed {
		if result.Removed == 0 && result.Failed == 0 {
			return []string{clean}
		}
		lines := []string{fmt.Sprintf("  ok  Reclaimed %d abandoned response-state temp file(s), %s freed.", result.Removed, doctorMB(result.BytesRemoved))}
		if result.Failed > 0 {
			lines = append(lines, fmt.Sprintf("  !!  %d file(s) could not be removed (in use or locked). Retried on the next reclaim — automatically while the proxy runs, otherwise re-run this command.", result.Failed))
		}
		if result.Truncated {
			lines = append(lines, "  !!  Cleanup budget reached; files remain. Run the command again to continue.")
		}
		return lines
	}
	if result.Eligible == 0 {
		return []string{clean}
	}
	lines := []string{fmt.Sprintf("  !!  %d abandoned response-state temp file(s), %s reclaimable.", result.Eligible, doctorMB(result.EligibleBytes)), "      These are interrupted snapshot writes (continuation cache only) and are safe to remove.", "      Reclaim them with: ocx doctor --reclaim-response-temps"}
	if result.Truncated {
		lines = append(lines, "      Scan stopped at its entry budget; the real total is higher.")
	}
	return lines
}
