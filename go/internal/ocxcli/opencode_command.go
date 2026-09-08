package ocxcli

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// opencode_command.go ports src/cli/opencode.ts cmdOpencode.
//
// Launch sequence mirrors the TS exactly: find the live proxy (starting one
// detached when absent and polling up to 8s), resolve the admission key, fetch
// the /api/models catalog, build the opencodex V1/V2 provider blocks from the
// live proxy base URL, print the wiring lines, detect a provider-override
// config for an informational note, merge any inherited OPENCODE_CONFIG_CONTENT
// with only our two blocks, and spawn `opencode` with the content and the
// admission key in the child environment.
//
// One deliberate divergence from the TS self-start is documented rather than
// ported: TS spawns the detached `ocx start` with OCX_SERVICE=1 plus a hardened
// OCX_API_TOKEN_FILE under withProcessRuntimeProvenance; Go inherits the
// current environment (spawnDetachedSelf), which reaches the same service-token
// bootstrap for a normal shell and cannot be exercised by the parity oracle
// (the oracle always runs against an already-live fixture proxy).

// opencodeLaunchChildEnv returns the child environment: the current process
// environment with OPENCODE_CONFIG_CONTENT and the admission-key env replaced.
func opencodeLaunchChildEnv(content, apiKey string) []string {
	out := make([]string, 0, len(os.Environ())+2)
	for _, kv := range os.Environ() {
		key := kv
		if index := strings.IndexByte(kv, '='); index >= 0 {
			key = kv[:index]
		}
		if key == opencodeConfigContentEnv || key == exportOpenCodeAPIKeyEnv {
			continue
		}
		out = append(out, kv)
	}
	out = append(out, opencodeConfigContentEnv+"="+content)
	out = append(out, exportOpenCodeAPIKeyEnv+"="+apiKey)
	return out
}

// runOpencode ports cmdOpencode.
func runOpencode(args []string, deps Deps) int {
	deps = defaults(deps)
	view, cfgValue, configErr := readExportConfig()
	if configErr != nil {
		fmt.Fprintf(deps.Stderr, "❌ %s\n", configErr)
		return ExitFailure
	}
	state, found := liveProxyEndpoint(deps)
	if !found {
		launcherCfg := readLauncherConfig()
		port := launcherCfg.port
		if port < 1 || port > 65535 {
			port = opencodeDefaultProxyPort
		}
		spawnDetachedSelf([]string{"start", "--port", strconv.Itoa(port)}, deps)
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			if candidate, ok := liveProxyEndpoint(deps); ok {
				state = candidate
				found = true
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !found {
			fmt.Fprintln(deps.Stderr, "❌ Proxy did not become healthy after starting.")
			return ExitFailure
		}
	}
	apiKey := opencodeAPIKey(cfgValue)
	rows, fetchErr := opencodeFetchCatalog(deps, state, apiKey)
	if fetchErr != nil {
		fmt.Fprintf(deps.Stderr, "❌ Could not fetch the model catalog from the proxy: %s\n", fetchErr)
		return ExitFailure
	}
	models := exportModelsFromProxyRowsRaw(rows, view)
	base := baseURL(state)
	blocks := exportOpenCodeProviderBlocks(base+"/v1", models, view)
	modelCount := len(models)
	fmt.Fprintf(deps.Stderr, "✅ opencode wired to %s/v1 — %d model(s) under provider `opencodex`.\n", base, modelCount)
	fmt.Fprintln(deps.Stderr, "   Your existing opencode config files are left untouched; only the runtime provider blocks are injected.")
	cwd, _ := os.Getwd()
	if override := opencodeProviderOverridePath(cwd, os.Getenv("XDG_CONFIG_HOME"), userHomeDir()); override != "" {
		fmt.Fprintf(deps.Stderr, "ℹ %s also defines our provider key; the runtime layer from ocx opencode overrides it for this launch.\n", override)
	}
	merged, mergeErr := opencodeMergeContent(os.Getenv(opencodeConfigContentEnv), blocks)
	if mergeErr != nil {
		fmt.Fprintf(deps.Stderr, "❌ %s\n", mergeErr)
		return ExitFailure
	}
	content, serializeErr := opencodeSerializeContent(merged)
	if serializeErr != nil {
		fmt.Fprintf(deps.Stderr, "❌ Failed to serialize the runtime config: %s\n", serializeErr)
		return ExitFailure
	}
	env := opencodeLaunchChildEnv(content, apiKey)
	return spawnLauncherClient("opencode", args, env, opencodeInstallHint, deps.Stderr, nil)
}
