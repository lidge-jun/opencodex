package ocxcli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

const shimMarker = "opencodex codex autostart shim"

// runCodexShim ports the read-only status operation. State mutation remains
// delegated because it owns launcher replacement and rollback transactions.
func runCodexShim(args []string, deps Deps) int {
	if len(args) != 1 || args[0] != "status" {
		return runDelegated(append([]string{"codex-shim"}, args...), deps)
	}
	dir, err := config.Dir()
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	path := filepath.Join(dir, "codex-shim.json")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		fmt.Fprintln(deps.Stdout, "Codex autostart shim is not installed.")
		return ExitOK
	}
	if err != nil {
		return invalidShimState(path, deps)
	}
	var state map[string]any
	if json.Unmarshal(raw, &state) != nil {
		return invalidShimState(path, deps)
	}
	platform, _ := state["platform"].(string)
	if platform == "" {
		return invalidShimState(path, deps)
	}
	files := []map[string]any{}
	if wrappers, ok := state["wrappers"].([]any); ok {
		for _, item := range wrappers {
			if file, ok := item.(map[string]any); ok {
				files = append(files, file)
			} else {
				return invalidShimState(path, deps)
			}
		}
	}
	if len(files) == 0 {
		files = append(files, state)
	}
	lines := []string{}
	healthy := true
	for _, file := range files {
		wrapperPath, wok := file["wrapperPath"].(string)
		originalPath, ook := file["originalPath"].(string)
		backupPath, bok := file["backupPath"].(string)
		if !wok || !ook || !bok || wrapperPath == "" || originalPath == "" || backupPath == "" {
			return invalidShimState(path, deps)
		}
		wrapper := "missing"
		if bytes, err := os.ReadFile(wrapperPath); err == nil {
			if strings.Contains(string(bytes), shimMarker) {
				wrapper = "shim present"
			} else {
				wrapper = "present but not an opencodex shim"
				healthy = false
			}
		} else {
			healthy = false
		}
		backup := "missing"
		if _, err := os.Stat(backupPath); err == nil {
			backup = "present"
		} else {
			healthy = false
		}
		lines = append(lines, fmt.Sprintf("Codex autostart shim: wrapper %s at %s; original backup %s at %s.", wrapper, wrapperPath, backup, backupPath))
	}
	fmt.Fprintln(deps.Stdout, strings.Join(lines, "\n"))
	if healthy {
		return ExitOK
	}
	return ExitFailure
}
func invalidShimState(path string, deps Deps) int {
	fmt.Fprintln(deps.Stdout, "Codex autostart shim state is invalid or corrupt at "+path+". Reinstall or remove the shim.")
	return ExitFailure
}
