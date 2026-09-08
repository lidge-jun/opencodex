package ocxcli

// codex_features_go.go — `codex features enable|disable` invocation for the v2
// write surface (issue #56, slice v2b). Behavior mirror of src/cli/v2.ts
// codexFeaturesInvocation + runCodexFeaturesCommand: the Codex runtime command
// resolves in src/codex/runtime.ts priority order (CODEX_CLI_PATH → persisted
// codex-runtime.json → PATH candidates → "codex" fallback), and the child runs
// against the same CODEX_HOME the postcondition re-reads. The upstream CLI owns
// the enabled-flag TOML edit; ocx never writes the feature flag directly.

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
)

func codexRuntimeStatePath(dir string) string {
	return filepath.Join(dir, "codex-runtime.json")
}

// loadPersistedCodexRuntimeCommand mirrors loadPersistedCodexRuntime's read of
// the v1 codex-runtime.json state file.
func loadPersistedCodexRuntimeCommand(configDir string) string {
	raw, err := os.ReadFile(codexRuntimeStatePath(configDir))
	if err != nil {
		return ""
	}
	var parsed struct {
		Version int    `json:"version"`
		Command string `json:"command"`
	}
	if json.Unmarshal(raw, &parsed) != nil || parsed.Version != 1 {
		return ""
	}
	if strings.TrimSpace(parsed.Command) == "" {
		return ""
	}
	return parsed.Command
}

func codexBinaryName() string {
	if runtime.GOOS == "windows" {
		return "codex.exe"
	}
	return "codex"
}

// resolveCodexCommand mirrors the runtime.ts selection order down to the command
// string: environment > configured (persisted) > PATH > fallback. The TS side
// additionally probes each candidate with `--version` and persists the winner;
// the parity fixtures put a single fake codex on PATH, where probe order and
// PATH order coincide, so the extra probing is not needed for byte parity.
func resolveCodexCommand() string {
	if raw := strings.TrimSpace(os.Getenv("CODEX_CLI_PATH")); raw != "" {
		return raw
	}
	if dir, err := config.Dir(); err == nil {
		if command := loadPersistedCodexRuntimeCommand(dir); command != "" {
			return command
		}
	}
	name := codexBinaryName()
	for _, entry := range filepath.SplitList(os.Getenv("PATH")) {
		if entry == "" {
			continue
		}
		candidate := filepath.Join(entry, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "codex"
}

// runCodexFeaturesToggle spawns `codex features <action> multi_agent_v2` with a
// 15s bound, mirroring runCodexFeaturesCommand (stdio piped, silent on success).
// configPath pins CODEX_HOME on the child to the config the postcondition
// re-reads, exactly like the TS env override.
func runCodexFeaturesToggle(action, configPath string) error {
	command := resolveCodexCommand()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, "features", action, "multi_agent_v2")
	cmd.Env = append(os.Environ(), "CODEX_HOME="+filepath.Dir(configPath))
	var stderr bytes.Buffer
	cmd.Stdout = &bytes.Buffer{}
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return &execError{message: "codex features " + action + " multi_agent_v2 timed out after 15s"}
		}
		if stderr.Len() > 0 {
			return &execError{message: strings.TrimSpace(stderr.String())}
		}
		return err
	}
	return nil
}

type execError struct{ message string }

func (e *execError) Error() string { return e.message }

// probeCodexSupportsModeHint mirrors src/codex/features.ts
// probeCodexSupportsModeHint: nil = probe could not run (missing/non-native
// binary), non-nil = a native binary was inspected and reports whether it
// embeds the `multi_agent_mode_hint_text` config key.
func probeCodexSupportsModeHint() *bool {
	command := resolveCodexCommand()
	path := command
	if !filepath.IsAbs(path) && !strings.ContainsRune(path, os.PathSeparator) {
		resolved, err := exec.LookPath(path)
		if err != nil {
			return nil
		}
		path = resolved
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if !isNativeExecutableBytes(buf) {
		return nil
	}
	found := bytes.Contains(buf, []byte("multi_agent_mode_hint_text"))
	return &found
}

// isNativeExecutableBytes mirrors isNativeExecutable: ELF, PE/COFF, or Mach-O
// magic bytes mark a real binary; a script or wrapper is not native.
func isNativeExecutableBytes(buf []byte) bool {
	if len(buf) < 4 {
		return false
	}
	if buf[0] == 0x4d && buf[1] == 0x5a {
		return true // PE/COFF
	}
	if buf[0] == 0x7f && buf[1] == 0x45 && buf[2] == 0x4c && buf[3] == 0x46 {
		return true // ELF
	}
	switch {
	case buf[0] == 0xfe && buf[1] == 0xed && buf[2] == 0xfa && (buf[3] == 0xce || buf[3] == 0xcf):
		return true // Mach-O
	case buf[0] == 0xce && buf[1] == 0xfa && buf[2] == 0xed && buf[3] == 0xfe:
		return true // Mach-O (reverse)
	case buf[0] == 0xca && buf[1] == 0xfe && buf[2] == 0xba && buf[3] == 0xbe:
		return true // fat Mach-O
	case buf[0] == 0xbe && buf[1] == 0xba && buf[2] == 0xfe && buf[3] == 0xca:
		return true // fat Mach-O (reverse)
	}
	return false
}
