package ocxcli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// doctorLiveProxyPID is intentionally conservative: a stale PID file must not
// block recovery, while a living recorded process must. The TypeScript probe
// also confirms the listener; process liveness is the safe native subset until
// that asynchronous probe is moved.
func doctorLiveProxyPID() int64 {
	pid := readStatusPIDFile()
	if pid > 0 && doctorProcessAlive(int(pid)) {
		return pid
	}
	return 0
}

type doctorRuntimeCandidate struct{ command, source, version string }

func doctorRuntimeCandidates() []doctorRuntimeCandidate {
	candidates := []doctorRuntimeCandidate{}
	for _, candidate := range statusRuntimeCandidates() {
		if version := statusCodexVersion(candidate.command); version != nil {
			candidates = append(candidates, doctorRuntimeCandidate{candidate.command, candidate.source, *version})
		}
	}
	return candidates
}

func doctorFixCodexRuntime() DoctorCommandResult {
	candidates := doctorRuntimeCandidates()
	if len(candidates) == 0 {
		return DoctorCommandResult{Text: "No newer Codex runtime found; keeping current selection.\nSelected: codex (unknown)\n", Exit: ExitOK}
	}
	selected := candidates[0]
	var newer *doctorRuntimeCandidate
	for index := range candidates[1:] {
		candidate := candidates[index+1]
		if candidate.command != selected.command && doctorCompareVersions(candidate.version, selected.version) > 0 && (newer == nil || doctorCompareVersions(candidate.version, newer.version) > 0) {
			copy := candidate
			newer = &copy
		}
	}
	if newer == nil {
		if err := doctorPersistRuntime(selected); err != nil {
			return DoctorCommandResult{Text: err.Error() + "\n", Exit: ExitFailure}
		}
		return DoctorCommandResult{Text: fmt.Sprintf("No newer Codex runtime found; keeping current selection.\nSelected: %s (%s)\n", selected.command, selected.version), Exit: ExitOK}
	}
	if selected.source == "environment" {
		return DoctorCommandResult{Text: fmt.Sprintf("CODEX_CLI_PATH currently overrides configured runtimes.\nUnset or update CODEX_CLI_PATH to use %s (%s).\nThen run ocx sync.\n", newer.command, newer.version), Exit: ExitOK}
	}
	configured := *newer
	configured.source = "configured"
	if err := doctorPersistRuntime(configured); err != nil {
		return DoctorCommandResult{Text: err.Error() + "\n", Exit: ExitFailure}
	}
	return DoctorCommandResult{Text: fmt.Sprintf("Updated Codex runtime to %s (%s).\nRun ocx sync to refresh the catalog against this runtime.\n", newer.command, newer.version), Exit: ExitOK}
}

func doctorCompareVersions(left, right string) int {
	// The status resolver recognizes the same versions as TypeScript. Codex
	// releases are numerical dotted versions; retain prerelease ordering below.
	parse := func(value string) (core []int, pre string) {
		parts := strings.SplitN(value, "-", 2)
		for _, part := range strings.Split(parts[0], ".") {
			var n int
			_, _ = fmt.Sscanf(part, "%d", &n)
			core = append(core, n)
		}
		if len(parts) == 2 {
			pre = parts[1]
		}
		return
	}
	a, ap := parse(left)
	b, bp := parse(right)
	for index := 0; index < len(a) || index < len(b); index++ {
		var av, bv int
		if index < len(a) {
			av = a[index]
		}
		if index < len(b) {
			bv = b[index]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	if ap == "" && bp != "" {
		return 1
	}
	if ap != "" && bp == "" {
		return -1
	}
	if ap < bp {
		return -1
	}
	if ap > bp {
		return 1
	}
	return 0
}

func doctorPersistRuntime(runtime doctorRuntimeCandidate) error {
	dir := statusConfigDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	version := runtime.version
	payload := statusPersistedRuntime{Version: 1, Command: runtime.command, Source: runtime.source, SelectedVersion: &version, UpdatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	target := filepath.Join(dir, "codex-runtime.json")
	temp, err := os.CreateTemp(dir, "codex-runtime.json.ocx.*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err = temp.Chmod(0o600); err == nil {
		_, err = temp.Write(append(raw, '\n'))
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tempName, target)
}
