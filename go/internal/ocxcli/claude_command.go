package ocxcli

// claude_command.go ports src/cli/claude.ts cmdClaude (issue #56 claude slice).
//
// Gate order mirrors the TS exactly: claudeCode.enabled=false block, then the
// client-state invalid/mismatched gate, then the connected branch (selected
// client + service-token fingerprint) or the local branch (ensure a live
// proxy, fetch the running windows), then env assembly (claudeBuildEnv), the
// root-skip notice, the gateway-model-cache prewrite, the roster-agent sync
// (local branch only), and finally the spawn of `claude` with the assembled
// environment. Message bytes on every gate and warning lane are oracle-frozen
// (devlog 260909 001).

import (
	"encoding/json"
	"fmt"
	"github.com/lidge-jun/opencodex/go/internal/config"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	claudeInboundDisabledMessage = "Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config)."
	claudeNotSelectedMessage     = "Claude is not selected for this remote hub connection."
	claudeTokenMissingMessage    = "Connected service token is missing."
	claudeTokenChangedMessage    = "Connected service token ownership changed."
	claudeProxyUnhealthyMessage  = "❌ Proxy did not become healthy after starting."
	claudeInstallHint            = "❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code"
	claudeContextFetchWarn       = "⚠ 모델 컨텍스트 정보를 불러오지 못했습니다 — 1M 자동 표시는 이번 실행에서 생략됩니다."
	claudeCacheWarnStatic        = "⚠ Gateway model cache could not be refreshed; the model picker may be stale."
	claudeAgentsWarnStatic       = "⚠ Claude agent definitions could not be synced; check ~/.claude/agents permissions."
)

// claudeLaunchConfig is the slice of config.json the launcher reads.
type claudeLaunchConfig struct {
	apiKeys             []string
	claudeCode          *claudeCodeView
	subagentModels      []string
	providersConfigured map[string]bool
}

// claudeConfigText reads a string field from a raw JSON object.
func claudeConfigText(object map[string]any, key string) string {
	value, ok := object[key].(string)
	if !ok {
		return ""
	}
	return value
}

// claudeConfigBool reads a *bool field (nil when absent or non-bool).
func claudeConfigBool(object map[string]any, key string) *bool {
	value, ok := object[key].(bool)
	if !ok {
		return nil
	}
	return &value
}

func claudeConfigFloat(object map[string]any, key string) *float64 {
	value, ok := object[key].(float64)
	if !ok {
		return nil
	}
	return &value
}

func claudeConfigStrings(object map[string]any, key string) []string {
	raw, ok := object[key].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, entry := range raw {
		text, isString := entry.(string)
		if isString {
			out = append(out, text)
		}
	}
	return out
}

func claudeConfigStringMap(object map[string]any, key string) map[string]string {
	raw, ok := object[key].(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for name, entry := range raw {
		text, isString := entry.(string)
		if isString {
			out[name] = text
		}
	}
	return out
}

// claudeDecodeView decodes the claudeCode block into the engine view.
func claudeDecodeView(object map[string]any) *claudeCodeView {
	raw, ok := object["claudeCode"].(map[string]any)
	if !ok || raw == nil {
		return nil
	}
	view := &claudeCodeView{
		Enabled:            claudeConfigBool(raw, "enabled"),
		AuthMode:           claudeConfigText(raw, "authMode"),
		Model:              claudeConfigText(raw, "model"),
		SmallFastModel:     claudeConfigText(raw, "smallFastModel"),
		AutoContext:        claudeConfigBool(raw, "autoContext"),
		AlwaysEnableEffort: false,
		NativePassthrough:  claudeConfigBool(raw, "nativePassthrough"),
		InjectAgents:       claudeConfigBool(raw, "injectAgents"),
		SubagentEffort:     claudeConfigText(raw, "subagentEffort"),
		BlockedSkills:      claudeConfigStrings(raw, "blockedSkills"),
		ModelMap:           claudeConfigStringMap(raw, "modelMap"),
	}
	if always, ok := raw["alwaysEnableEffort"].(bool); ok {
		view.AlwaysEnableEffort = always
	}
	if window, ok := raw["autoCompactWindow"].(float64); ok && window == float64(int64(window)) {
		value := int64(window)
		view.AutoCompactWindow = &value
	}
	if maxCtx, ok := raw["maxContextTokens"].(float64); ok {
		view.MaxContextTokens = &maxCtx
	}
	if tiers, ok := raw["tierModels"].(map[string]any); ok && tiers != nil {
		view.TierModels = claudeTierModels{
			Opus:   strPtrOrNil(claudeConfigText(tiers, "opus")),
			Sonnet: strPtrOrNil(claudeConfigText(tiers, "sonnet")),
			Haiku:  strPtrOrNil(claudeConfigText(tiers, "haiku")),
			Fable:  strPtrOrNil(claudeConfigText(tiers, "fable")),
		}
	}
	return view
}

func strPtrOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// claudeLoadLaunchConfig reads config.json into the launcher slice. A missing
// or unparseable file yields zero defaults (mirrors the TS zod loader's
// defaults for a fresh install; a corrupted file is not an oracle surface).
func claudeLoadLaunchConfig() claudeLaunchConfig {
	cfg := claudeLaunchConfig{providersConfigured: map[string]bool{}}
	raw, ok := readRawTopLevelConfig()
	if !ok {
		return cfg
	}
	cfg.claudeCode = claudeDecodeView(raw)
	if keys, ok := raw["apiKeys"].([]any); ok {
		for _, entry := range keys {
			object, isObject := entry.(map[string]any)
			if !isObject {
				continue
			}
			if key := claudeConfigText(object, "key"); key != "" {
				cfg.apiKeys = append(cfg.apiKeys, key)
			}
		}
	}
	cfg.subagentModels = claudeConfigStrings(raw, "subagentModels")
	if providers, ok := raw["providers"].(map[string]any); ok {
		for name := range providers {
			cfg.providersConfigured[name] = true
		}
	}
	return cfg
}

// claudeEnvFromProcess mirrors {...process.env}: the full inherited process
// environment as the assembly base (trusted-env semantics, grill 2026-09-09).
func claudeEnvFromProcess() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		if index := strings.IndexByte(kv, '='); index >= 0 {
			out[kv[:index]] = kv[index+1:]
		}
	}
	return out
}

// claudeEnvToSpawnList flattens the assembled env map for the child spawn.
func claudeEnvToSpawnList(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}

// claudeFetchContextWindows mirrors fetchClaudeContextWindows: read the
// running proxy's /api/claude-code context-window map (management auth header,
// 3s bound). A non-ok response yields {} silently; a transport failure prints
// the Korean warning once and yields {}.
func claudeFetchContextWindows(port int, adminToken string, client *http.Client, stderr io.Writer) map[string]int64 {
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/claude-code", nil)
	if err != nil {
		return map[string]int64{}
	}
	if strings.TrimSpace(adminToken) != "" {
		req.Header.Set("x-opencodex-api-key", adminToken)
	}
	res, err := client.Do(req)
	if err != nil {
		fmt.Fprintln(stderr, claudeContextFetchWarn)
		return map[string]int64{}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return map[string]int64{}
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024))
	if err != nil {
		return map[string]int64{}
	}
	var parsed struct {
		ContextWindows map[string]float64 `json:"contextWindows"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.ContextWindows == nil {
		return map[string]int64{}
	}
	out := map[string]int64{}
	for key, value := range parsed.ContextWindows {
		out[key] = int64(value)
	}
	return out
}

// claudeRootSkipNotice mirrors rootSkipPermissionsNotice.
func claudeRootSkipNotice(env map[string]string) string {
	if env["IS_SANDBOX"] == "1" {
		return "⚠ Root --dangerously-skip-permissions requested: OpenCodex set IS_SANDBOX=1 to bypass Claude Code's root guard. OpenCodex did not create an OS sandbox; prefer running as a non-root user."
	}
	return "⚠ Root --dangerously-skip-permissions requested: preserving user IS_SANDBOX=" + env["IS_SANDBOX"] + "; Claude Code's root guard remains in control."
}

// claudeShouldAllowRootSkip mirrors shouldAllowRootSkipPermissions.
func claudeShouldAllowRootSkip(args []string) bool {
	allow := false
	for _, arg := range args {
		if arg == "--dangerously-skip-permissions" {
			allow = true
		}
	}
	if !allow {
		return false
	}
	// os.Getuid exists on every Go platform (windows reports -1, never 0), so
	// the TS typeof-guard is satisfied unconditionally here.
	return os.Getuid() == 0
}

// claudeEnsureLocalProxy mirrors ensureProxyForClaude: locate the live proxy
// (a just-bound proxy can miss one probe, so the runtime record is tried three
// times), otherwise spawn a detached `ocx start` and poll for liveness up to 8s.
func claudeEnsureLocalProxy(deps Deps) (int, bool) {
	deps = defaults(deps)
	for attempt := 0; attempt < 3; attempt++ {
		if state, ok := liveProxyEndpoint(deps); ok {
			return state.Port, true
		}
	}
	cfg, err := loadCLIConfig()
	port := opencodeDefaultProxyPort
	if err == nil {
		if raw, ok := cfg["port"].(float64); ok && raw == float64(int64(raw)) && raw >= 1 && raw <= 65535 {
			port = int(raw)
		}
	}
	if !spawnDetachedSelf([]string{"start", "--port", strconv.Itoa(port)}, deps) {
		return 0, false
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if state, ok := liveProxyEndpoint(deps); ok {
			return state.Port, true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return 0, false
}

// runClaude ports cmdClaude. It is a pure executor: every byte-critical branch
// is covered by the claude parity describe (tests/go-cli-parity.test.ts) or the
// unit tests in claude_command_test.go.
func runClaude(args []string, deps Deps) int {
	deps = defaults(deps)
	configDir, dirErr := config.Dir()
	if dirErr != nil {
		fmt.Fprintf(deps.Stderr, "❌ %s\n", dirErr)
		return ExitFailure
	}

	cfg := claudeLoadLaunchConfig()
	if cfg.claudeCode != nil && cfg.claudeCode.Enabled != nil && !*cfg.claudeCode.Enabled {
		fmt.Fprintln(deps.Stderr, claudeInboundDisabledMessage)
		return ExitFailure
	}

	clientState := readClientConnectionState()
	if clientState.kind == connectionInvalid || clientState.kind == connectionMismatched {
		fmt.Fprintf(deps.Stderr, "Client state is %s: %s\n", clientState.kind, clientState.reason)
		return ExitFailure
	}

	var route claudeLaunchRoute
	var contextWindows map[string]int64
	if clientState.kind == connectionConnected {
		value := clientState.value
		selected := false
		for _, name := range value.SelectedClients {
			if name == "claude" {
				selected = true
			}
		}
		if !selected {
			fmt.Fprintln(deps.Stderr, claudeNotSelectedMessage)
			return ExitFailure
		}
		tokenState := readServiceAPITokenState(configDir)
		if tokenState.kind != "present" || tokenState.fingerprint != value.TokenFingerprint {
			if tokenState.kind == "absent" {
				fmt.Fprintln(deps.Stderr, claudeTokenMissingMessage)
			} else {
				fmt.Fprintln(deps.Stderr, claudeTokenChangedMessage)
			}
			return ExitFailure
		}
		route = connectedClaudeRoute(value.ServerURL, tokenState.token)
		codexHome, err := codexHomeFromEnv()
		catalogPath := filepath.Join(".", "opencodex-catalog.json")
		if err == nil {
			catalogPath = defaultCatalogPath(codexHome)
		}
		contextWindows = claudeReadConnectedContextWindows(catalogPath)
	} else {
		port, ok := claudeEnsureLocalProxy(deps)
		if !ok {
			fmt.Fprintln(deps.Stderr, claudeProxyUnhealthyMessage)
			return ExitFailure
		}
		route = localClaudeRoute(port)
		adminToken := configuredUsageAdminToken()
		client := deps.HTTPClient
		contextWindows = claudeFetchContextWindows(port, adminToken, client, deps.Stderr)
	}

	allowRootSkip := claudeShouldAllowRootSkip(args)
	base := claudeEnvFromProcess()
	launch := claudeBuildEnv(claudeEngineInput{
		apiKeys:                  cfg.apiKeys,
		claudeCode:               cfg.claudeCode,
		route:                    route,
		base:                     base,
		contextWindows:           contextWindows,
		allowRootSkipPermissions: allowRootSkip,
		deps: claudeEngineDeps{
			procEnv: os.Getenv,
			warn: func(line string) {
				fmt.Fprintln(deps.Stderr, line)
			},
		},
	})
	if allowRootSkip {
		fmt.Fprintln(deps.Stderr, claudeRootSkipNotice(launch.Env))
	}

	// Gateway-model-cache prewrite (the CLI never refreshes it without a
	// credential; the picker would otherwise keep showing yesterday's aliases).
	home, _ := os.UserHomeDir()
	cacheDir := claudeConfigDir(home, os.Getenv("CLAUDE_CONFIG_DIR"))
	opts := claudeCacheRefreshOptions{
		ConfigDir:   cacheDir,
		APIKeys:     cfg.apiKeys,
		EnvToken:    strings.TrimSpace(os.Getenv("OPENCODEX_API_AUTH_TOKEN")),
		ServiceFile: claudeServiceFileToken(configDir, os.Getenv("OCX_API_TOKEN_FILE")),
	}
	cachePath := claudeRefreshGatewayCacheFromProxy(route, opts)
	if cachePath == "" {
		fmt.Fprintln(deps.Stderr, claudeCacheWarnStatic)
	}

	// Roster-agent sync is local-branch only, like the TS `typeof route ===
	// "number"` guard (a connected hub owns its own agents).
	if route.target == nil {
		slice := cfg.claudeCode
		if slice != nil {
			slice.providersConfigured = cfg.providersConfigured
		}
		_, syncErr := claudeInjectAgentDefs(slice, cfg.subagentModels, contextWindows, cacheDir)
		if syncErr != nil {
			fmt.Fprintf(deps.Stderr, "⚠ Claude agent definitions could not be synced: %s\n", syncErr.Error())
		}
	}

	envList := claudeEnvToSpawnList(launch.Env)
	return spawnLauncherClient("claude", args, envList, claudeInstallHint, deps.Stderr, nil)
}
