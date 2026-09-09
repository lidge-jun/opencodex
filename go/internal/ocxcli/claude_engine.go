package ocxcli

// Claude launch environment assembly — the Go mirror of buildClaudeEnv in
// src/cli/claude.ts (issue #56 slice). Byte-for-byte parity with TypeScript is
// the contract: Claude Code reads ANTHROPIC_AUTH_TOKEN / API_KEY, BASE_URL and
// the model-slot variables from the exact strings we spawn with.
//
// Env provenance decision (grill, 2026-09-09): the Go runtime treats process
// environment as trusted — an ambient ANTHROPIC_* variable is a genuine parent
// export, matching the npm-launcher UX. The TypeScript untrusted-strip lane is
// therefore vacuous on both sides of every parity row (goldens simulate a
// trusted launcher by listing the exported slots).

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// ClaudeRoutingTarget mirrors ClaudeRoutingTarget in cli/claude.ts.
type claudeRoutingTarget struct {
	BaseURL        string
	AdmissionToken string
}

// claudeLaunchRoute is port-or-target (local proxy port vs connected hub).
type claudeLaunchRoute struct {
	port   int // > 0 when local
	target *claudeRoutingTarget
}

func localClaudeRoute(port int) claudeLaunchRoute {
	return claudeLaunchRoute{port: port}
}

func connectedClaudeRoute(baseURL, admissionToken string) claudeLaunchRoute {
	return claudeLaunchRoute{target: &claudeRoutingTarget{BaseURL: baseURL, AdmissionToken: admissionToken}}
}

// claudeEngineDeps carries the IO seams the TS engine injects.
type claudeEngineDeps struct {
	// authDetect overrides the default file/keychain/env detection (goldens and
	// unit tests always inject one; production uses nil → default IO).
	authDetect *claudeAuthDetectDeps
	// warn mirrors console.error during assembly. Production prints to stderr;
	// tests collect the lines to compare with golden logs.
	warn func(string)
	// procEnv reads the PROCESS environment (data-plane/admin admission env
	// tokens live there, not in the launch env — same read site as TS).
	procEnv func(string) string
}

type claudeEngineInput struct {
	apiKeys              []string
	claudeCode           *claudeCodeView
	route                claudeLaunchRoute
	base                 map[string]string
	contextWindows       map[string]int64
	allowRootSkipPermissions bool
	deps                 claudeEngineDeps
}

var (
	ocxAdmissionPrefixRe = regexp.MustCompile(`^ocx_(?:data|admin|session)_`)
	ocxAdmissionHexRe    = regexp.MustCompile(`^ocx_[0-9a-f]{40}$`)
)

// claudeIsProxyAdmissionSecret mirrors isProxyAdmissionSecret (auth-cors.ts).
// procEnv reads OPENCODEX_API_AUTH_TOKEN / OPENCODEX_ADMIN_AUTH_TOKEN.
func claudeIsProxyAdmissionSecret(value string, apiKeys []string, procEnv func(string) string) bool {
	actual := strings.TrimSpace(value)
	if actual == "" {
		return false
	}
	if ocxAdmissionPrefixRe.MatchString(actual) || ocxAdmissionHexRe.MatchString(actual) {
		return true
	}
	// Data plane: the OPENCODEX_API_AUTH_TOKEN env secret or a configured key.
	if envToken := strings.TrimSpace(procEnv("OPENCODEX_API_AUTH_TOKEN")); envToken != "" && actual == envToken {
		return true
	}
	for _, key := range apiKeys {
		if actual == key {
			return true
		}
	}
	// Management plane: the OPENCODEX_ADMIN_AUTH_TOKEN env secret.
	if adminToken := strings.TrimSpace(procEnv("OPENCODEX_ADMIN_AUTH_TOKEN")); adminToken != "" && actual == adminToken {
		return true
	}
	return false
}

// urlOriginNode mirrors the URL origin serialization Node/WHATWG uses: default
// ports are omitted.
func urlOriginNode(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return originOf(parsed)
}

func originOf(parsed *url.URL) string {
	if parsed.Scheme == "" {
		return ""
	}
	host := parsed.Hostname()
	if host == "" {
		return ""
	}
	defaultPort := ""
	if parsed.Scheme == "http" {
		defaultPort = "80"
	} else if parsed.Scheme == "https" {
		defaultPort = "443"
	}
	origin := parsed.Scheme + "://" + host
	if parsed.Port() != "" && parsed.Port() != defaultPort {
		origin += ":" + parsed.Port()
	}
	return origin
}

func claudeURLPort(raw string) (int, bool) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return 0, false
	}
	if parsed.Port() == "" {
		return 80, true
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		return 0, false
	}
	return port, true
}

func claudeIsLoopbackHostname(hostname string) bool {
	normalized := strings.ToLower(strings.TrimSuffix(hostname, "."))
	switch normalized {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

func claudeTargetsLocalProxy(value string, port int) bool {
	if value == "" {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	effectivePort, ok := claudeURLPort(value)
	if !ok {
		return false
	}
	return parsed.Scheme == "http" &&
		claudeIsLoopbackHostname(parsed.Hostname()) &&
		effectivePort == port &&
		parsed.User == nil
}

func claudeTargetsRoutingTarget(value string, target claudeRoutingTarget) bool {
	if value == "" {
		return false
	}
	actual, err := url.Parse(value)
	if err != nil {
		return false
	}
	expected, err := url.Parse(target.BaseURL)
	if err != nil {
		return false
	}
	return originOf(actual) == originOf(expected) &&
		(actual.Path == "/" || actual.Path == "") &&
		actual.User == nil
}

// claudeManagedBaseURL mirrors the managedBaseUrl derivation: explicit targets
// use the hub origin; local routes use http://127.0.0.1:<port>.
func claudeManagedBaseURL(route claudeLaunchRoute) string {
	if route.target != nil {
		return urlOriginNode(route.target.BaseURL)
	}
	return "http://127.0.0.1:" + strconv.Itoa(route.port)
}

func claudeEnvSetDefault(env map[string]string, name, value string) {
	if value == "" {
		return
	}
	if existing, ok := env[name]; ok && existing != "" {
		return // user wins
	}
	env[name] = value
}

func claudeEnvDepsWarn(deps claudeEngineDeps, line string) {
	if deps.warn != nil {
		deps.warn(line)
	}
}

// claudeEngineLaunchEnv is the assembled spawn environment plus warnings written
// during assembly (kept ordered for golden comparison).
type claudeEngineLaunchEnv struct {
	Env    map[string]string
	Warned []string
}

// claudeBuildEnv mirrors buildClaudeEnv.
func claudeBuildEnv(input claudeEngineInput) claudeEngineLaunchEnv {
	route := input.route
	explicitTarget := route.target != nil
	env := map[string]string{}
	for k, v := range input.base {
		env[k] = v
	}
	if input.deps.procEnv == nil {
		input.deps.procEnv = func(string) string { return "" }
	}
	procEnv := input.deps.procEnv
	var warned []string
	warn := func(line string) {
		warned = append(warned, line)
		claudeEnvDepsWarn(input.deps, line)
	}

	// Step 1 — strip our own dummy from the inherited environment before
	// anything reads or writes the token slot.
	if strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"]) == claudeProxyMarker {
		delete(env, "ANTHROPIC_AUTH_TOKEN")
	}
	// Step 1b — provenance strip is vacuous under trusted-env semantics, but the
	// seam keys themselves never forward to Claude Code.
	delete(env, "OCX_PRE_BUN_ANTHROPIC_ENV")
	delete(env, "OCX_NODE_LAUNCH_CONTEXT")

	if input.allowRootSkipPermissions {
		claudeEnvSetDefault(env, "IS_SANDBOX", "1")
	}
	managedBaseURL := claudeManagedBaseURL(route)
	claudeEnvSetDefault(env, "ANTHROPIC_BASE_URL", managedBaseURL)
	existingBaseURL := env["ANTHROPIC_BASE_URL"]
	var port *int
	if route.target == nil {
		p := route.port
		port = &p
	}
	if existingBaseURL != "" && port != nil {
		if parsed, err := url.Parse(existingBaseURL); err == nil {
			effectivePort, ok := claudeURLPort(existingBaseURL)
			if ok && parsed.Scheme == "http" && claudeIsLoopbackHostname(parsed.Hostname()) && effectivePort != *port {
				replacement := "http://127.0.0.1:" + strconv.Itoa(*port)
				warn("⚠ Replacing stale opencodex ANTHROPIC_BASE_URL " + originOf(parsed) + " with " + replacement + ".")
				env["ANTHROPIC_BASE_URL"] = replacement
				for _, slot := range []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"} {
					value := strings.TrimSpace(env[slot])
					if value == "" {
						continue
					}
					if value == claudeProxyMarker || claudeIsProxyAdmissionSecret(value, input.apiKeys, procEnv) {
						delete(env, slot)
					}
				}
			}
		}
	}

	var ownTokens []string
	if explicitTarget {
		ownTokens = []string{route.target.AdmissionToken}
	} else {
		ownTokens = claudeOwnAdmissionTokens(input.apiKeys)
	}
	targetsLocalProxy := false
	if explicitTarget {
		targetsLocalProxy = claudeTargetsRoutingTarget(env["ANTHROPIC_BASE_URL"], *route.target)
	} else {
		targetsLocalProxy = claudeTargetsLocalProxy(env["ANTHROPIC_BASE_URL"], route.port)
	}
	isOwnAdmissionToken := func(value string) bool {
		return containsString(ownTokens, value) || claudeIsProxyAdmissionSecret(value, input.apiKeys, procEnv)
	}
	if inheritedAPIKey, ok := env["ANTHROPIC_API_KEY"]; ok && isOwnAdmissionToken(inheritedAPIKey) {
		delete(env, "ANTHROPIC_API_KEY")
	}
	hasUserAPIKey := strings.TrimSpace(env["ANTHROPIC_API_KEY"]) != ""
	inheritedAuthToken, hasInheritedToken := env["ANTHROPIC_AUTH_TOKEN"]
	inheritedTokenIsOurs := hasInheritedToken && isOwnAdmissionToken(inheritedAuthToken)
	if inheritedTokenIsOurs && (!targetsLocalProxy || hasUserAPIKey) {
		delete(env, "ANTHROPIC_AUTH_TOKEN")
	}

	// Detection reads the sanitized launch env before proxy-owned credentials
	// are added.
	detectDeps := input.deps.authDetect
	if detectDeps == nil {
		d := claudeDefaultAuthDetectDeps(env, ownTokens)
		detectDeps = &d
	} else {
		cp := *detectDeps
		cp.ownTokens = ownTokens
		cp.env = func() map[string]string { return env }
		detectDeps = &cp
	}
	detection := claudeDetectAuth(*detectDeps)
	resolved := claudeResolveAuthMode(input.claudeCode, detection)

	if resolved.MarkerMode == claudeMarkerSubscription && !explicitTarget {
		token := strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"])
		if token != "" && (token == claudeProxyMarker || claudeIsProxyAdmissionSecret(token, input.apiKeys, procEnv)) {
			delete(env, "ANTHROPIC_AUTH_TOKEN")
		}
	} else if targetsLocalProxy && !hasUserAPIKey && len(ownTokens) > 0 {
		claudeEnvSetDefault(env, "ANTHROPIC_AUTH_TOKEN", ownTokens[0])
	}
	if env["ANTHROPIC_AUTH_TOKEN"] == "" && !hasUserAPIKey && targetsLocalProxy && resolved.MarkerMode == claudeMarkerProxy {
		env["ANTHROPIC_AUTH_TOKEN"] = claudeProxyMarker
	}
	finalAuthToken, hasFinal := env["ANTHROPIC_AUTH_TOKEN"]
	hostOwnsAuthentication := targetsLocalProxy &&
		!hasUserAPIKey &&
		hasFinal &&
		(strings.TrimSpace(finalAuthToken) == claudeProxyMarker || isOwnAdmissionToken(finalAuthToken))
	if resolved.Origin == claudeOriginAutoUnknown {
		warn("⚠ Claude 인증을 확인하지 못했습니다 — 구독 방식으로 진행합니다. GUI에서 인증 모드를 직접 지정하면 이 판단을 덮어쓸 수 있습니다.")
	}
	claudeEnvSetDefault(env, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1")
	if hostOwnsAuthentication {
		claudeEnvSetDefault(env, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1")
	}
	if input.claudeCode != nil && input.claudeCode.AlwaysEnableEffort {
		claudeEnvSetDefault(env, "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "1")
	}
	if input.claudeCode != nil && input.claudeCode.MaxContextTokens != nil {
		maxCtx := *input.claudeCode.MaxContextTokens
		if !math.IsNaN(maxCtx) && !math.IsInf(maxCtx, 0) && maxCtx > 0 {
			claudeEnvSetDefault(env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS", strconv.FormatInt(int64(math.Floor(maxCtx)), 10))
			claudeEnvSetDefault(env, "DISABLE_COMPACT", "1")
		}
	}
	userAutoCompact := ""
	if raw, ok := input.base["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]; ok && raw != "" {
		userAutoCompact = raw
	}
	slice := claudeAutoContextSlice{}
	if input.claudeCode != nil {
		slice = claudeAutoContextSlice{
			AutoContext:       input.claudeCode.AutoContext,
			AutoCompactWindow: input.claudeCode.AutoCompactWindow,
			MaxContextTokens:  input.claudeCode.MaxContextTokens,
		}
	}
	auto := claudeResolveAutoContext(slice, userAutoCompact)
	if auto.Enabled {
		claudeEnvSetDefault(env, "CLAUDE_CODE_AUTO_COMPACT_WINDOW", strconv.FormatInt(auto.CompactWindow, 10))
	}
	modelEnv := claudeEffectiveModelEnv(claudeCodeOrEmpty(input.claudeCode), input.contextWindows, &auto)
	for name, value := range modelEnv {
		claudeEnvSetDefault(env, name, value)
	}
	launch := claudeEngineLaunchEnv{Env: env, Warned: warned}
	if warned == nil {
		launch.Warned = []string{}
	}
	return launch
}

func claudeCodeOrEmpty(slice *claudeCodeView) claudeCodeView {
	if slice != nil {
		return *slice
	}
	return claudeCodeView{}
}
