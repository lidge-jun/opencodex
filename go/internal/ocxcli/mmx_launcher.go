package ocxcli

// ocx mmx — the MiniMax CLI text launcher (issue #54 launcher slice). Ports
// cmdMmx from src/cli/minimax.ts: the MMX global-flag scanner, the loopback
// gates, the isolated temporary config directory, the loopback-only text
// bridge that adapts /anthropic/v1/messages to the canonical data plane, the
// scrubbed child environment, and the inherited-stdio spawn.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// mmxChildOwnedEnvKeys mirrors MMX_CHILD_OWNED_ENV_KEYS: any inherited spelling
// of these (the official client installs one ProxyAgent when any proxy variable
// is present and does not apply NO_PROXY) is stripped case-insensitively before
// the wrapper-owned values are installed.
var mmxChildOwnedEnvKeys = map[string]bool{
	"MMX_CONFIG_DIR":   true,
	"MINIMAX_BASE_URL": true,
	"MINIMAX_REGION":   true,
	"MINIMAX_API_KEY":  true,
	"HTTP_PROXY":       true,
	"HTTPS_PROXY":      true,
	"ALL_PROXY":        true,
}

func mmxBuildEnv(base []string, baseURL string, configDir string) []string {
	out := []string{}
	for _, entry := range base {
		key, _, found := strings.Cut(entry, "=")
		if found && mmxChildOwnedEnvKeys[strings.ToUpper(key)] {
			continue
		}
		out = append(out, entry)
	}
	out = append(out, "MMX_CONFIG_DIR="+configDir, "MINIMAX_BASE_URL="+baseURL, "MINIMAX_REGION=global")
	return out
}

func runMmx(args []string, deps Deps) int {
	deps = defaults(deps)
	if standaloneInformational(args, "mmx") {
		return spawnLauncherClient("mmx", args, nil, mmxInstallHint)
	}
	if unsafe := mmxUnsafeOverride(args); unsafe != "" {
		fmt.Fprintf(deps.Stderr, "❌ %s is not accepted by ocx mmx because it could bypass the proxy or expose a caller credential.\n", unsafe)
		return 2
	}
	commandPath := mmxCommandPath(args)
	if len(commandPath) == 0 || commandPath[0] != "text" {
		fmt.Fprintln(deps.Stderr, "❌ ocx mmx supports only `mmx text` commands. Use plain `mmx` for MiniMax image, video, speech, music, vision, search, quota, auth, config, file, and update APIs.")
		return 2
	}
	cfg := readLauncherConfig()
	if !isLoopbackHostname(cfg.hostname) {
		fmt.Fprintln(deps.Stderr, "❌ ocx mmx is loopback-only; MMX has no field for OpenCodex's dedicated remote-admission header.")
		return 2
	}
	state, ok := ensureLauncherProxy(cfg, deps)
	if !ok {
		fmt.Fprintln(deps.Stderr, "❌ Proxy did not become healthy after starting.")
		return 1
	}
	configDir, mkdirErr := os.MkdirTemp("", "opencodex-mmx-")
	if mkdirErr != nil {
		fmt.Fprintf(deps.Stderr, "❌ Failed to create the MMX isolation directory: %s\n", mkdirErr)
		return 1
	}
	bridge, bridgeErr := startMmxTextBridge(probeHost(state.Hostname), state.Port, deps)
	if bridgeErr != nil {
		_ = os.RemoveAll(configDir)
		fmt.Fprintf(deps.Stderr, "❌ Failed to start the MMX text bridge: %s\n", bridgeErr)
		return 1
	}
	cleanup := func() {
		bridge.stop()
		_ = os.RemoveAll(configDir)
	}
	// Isolate MMX from ~/.mmx OAuth/API-key state. The only credential in this
	// temporary file is a public loopback placeholder, and the directory is
	// removed as soon as the child exits.
	configPath := filepath.Join(configDir, "config.json")
	configText, jsonErr := json.MarshalIndent(map[string]string{
		"api_key": loopbackKey,
		"region":  "global",
	}, "", "  ")
	if jsonErr == nil {
		jsonErr = os.WriteFile(configPath, append(configText, '\n'), 0o600)
	}
	if jsonErr != nil {
		cleanup()
		fmt.Fprintf(deps.Stderr, "❌ Failed to write the MMX isolation config: %s\n", jsonErr)
		return 1
	}
	env := mmxBuildEnv(os.Environ(), "http://127.0.0.1:"+strconv.Itoa(bridge.port()), configDir)
	upstream := "http://" + probeHost(state.Hostname) + ":" + strconv.Itoa(state.Port)
	fmt.Fprintf(deps.Stderr, "✅ MiniMax CLI text bridged to %s/v1/messages.\n", upstream)
	code := spawnLauncherClient("mmx", args, env, mmxInstallHint)
	cleanup()
	return code
}
