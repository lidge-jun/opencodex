// ocx debug — the runtime debug-flag family (provider/usage/injection/claude
// with on|off|status|reset|logs [-f]). This file ports the TypeScript owner
// (src/cli/debug.ts) exactly: it reads and writes the running proxy's
// /api/debug settings and buffered log endpoints with the TS failure wording
// (no "Error:" prefix, exit 1) and the env-default help block for a stopped
// proxy.
package ocxcli

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// debugFlags mirrors the scopes of DEBUG_ENV plus the legacy provider env in
// src/lib/debug-settings.ts. overallKey names the DebugSettingsView member
// that reports the scope's effective state.
type debugFlag struct {
	name       string // scope key used on the wire and in messages
	title      string // "Provider", "Usage", "Injection", "Claude inbound"
	envName    string // DEBUG_ENV.<flag>
	legacyEnv  string // legacy provider env (OCX_DEBUG_FRAMES)
	overallKey string
	hasLogs    bool
}

var debugFlags = map[string]debugFlag{
	"provider":  {name: "provider", title: "Provider", envName: "OCX_DEBUG", legacyEnv: "OCX_DEBUG_FRAMES", overallKey: "enabled", hasLogs: true},
	"usage":     {name: "usage", title: "Usage", envName: "OPENCODEX_USAGE_DEBUG", overallKey: "usage", hasLogs: true},
	"injection": {name: "injection", title: "Injection", envName: "OCX_INJECTION_DEBUG", overallKey: "injection"},
	"claude":    {name: "claude", title: "Claude inbound", envName: "OCX_CLAUDE_DEBUG", overallKey: "claude"},
}

// runDebug implements `ocx debug`. argv carries only this command's arguments;
// Run already handled --help/-h/help tokens at dispatch time.
func runDebug(args []string, deps Deps) int {
	sub := ""
	if len(args) > 0 {
		sub = strings.ToLower(strings.TrimSpace(args[0]))
	}
	if flag, ok := debugFlags[sub]; ok {
		return debugHandleScope(flag, args[1:], deps)
	}
	if sub == "" || sub == "help" || sub == "--help" || sub == "-h" {
		debugPrintTopLevelHelp(deps, !liveProxyAvailable(deps))
		return ExitOK
	}
	debugPrintTopLevelHelp(deps, false)
	return ExitFailure
}

// liveProxyAvailable mirrors findLiveProxy() != null in debug.ts (used only to
// decide whether the env-default block precedes the top-level help).
func liveProxyAvailable(deps Deps) bool {
	deps = defaults(deps)
	_, found := liveProxyEndpoint(deps)
	return found
}

// debugPrintTopLevelHelp mirrors printTopLevelHelp plus the stopped-proxy
// env-default block of handleDebugCommand.
func debugPrintTopLevelHelp(deps Deps, envDefaults bool) {
	if envDefaults {
		fmt.Fprintln(deps.Stdout, "Proxy is not running — env defaults for the next start:")
		fmt.Fprintf(deps.Stdout, "  provider → OCX_DEBUG = %s\n", boolWord(envOn("OCX_DEBUG") || envOn("OCX_DEBUG_FRAMES")))
		fmt.Fprintf(deps.Stdout, "  usage    → %s = %s\n", debugFlags["usage"].envName, boolWord(envOn(debugFlags["usage"].envName)))
		fmt.Fprintf(deps.Stdout, "  injection→ %s = %s\n", debugFlags["injection"].envName, boolWord(envOn(debugFlags["injection"].envName)))
		fmt.Fprintf(deps.Stdout, "  claude   → %s = %s\n", debugFlags["claude"].envName, boolWord(envOn(debugFlags["claude"].envName)))
		fmt.Fprintln(deps.Stdout)
	}
	fmt.Fprintln(deps.Stdout, "Debug commands (proxy must be running):")
	fmt.Fprintln(deps.Stdout)
	fmt.Fprintln(deps.Stdout, "  ocx debug provider on|off|status|reset|logs [-f]")
	fmt.Fprintln(deps.Stdout, "  ocx debug usage on|off|status|reset|logs [-f]")
	fmt.Fprintln(deps.Stdout, "  ocx debug injection on|off|status|reset")
	fmt.Fprintln(deps.Stdout, "  ocx debug claude on|off|status|reset")
	fmt.Fprintln(deps.Stdout)
	fmt.Fprintln(deps.Stdout, "Env defaults on start:")
	fmt.Fprintf(deps.Stdout, "  provider → %s=1 (legacy %s still works)\n", debugFlags["provider"].envName, debugFlags["provider"].legacyEnv)
	fmt.Fprintf(deps.Stdout, "  usage    → %s=1\n", debugFlags["usage"].envName)
	fmt.Fprintf(deps.Stdout, "  injection→ %s=1\n", debugFlags["injection"].envName)
	fmt.Fprintf(deps.Stdout, "  claude   → %s=1\n", debugFlags["claude"].envName)
}

func envOn(name string) bool { return os.Getenv(name) == "1" }
func boolWord(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

func debugHandleScope(flag debugFlag, actionArgv []string, deps Deps) int {
	scope := flag.name
	action := "status"
	if len(actionArgv) > 0 {
		action = strings.ToLower(strings.TrimSpace(actionArgv[0]))
	}
	switch action {
	case "on", "off":
		enabled := action == "on"
		view, code := debugPutSettings(deps, fmt.Sprintf(`{"%s":%t}`, debugWireKey(scope), enabled))
		if code != ExitOK {
			return code
		}
		debugPrintScopeStatus(scope, view, deps)
		if enabled {
			fmt.Fprintf(deps.Stdout, "\n%s debug is now enabled.\n", scope)
		} else {
			fmt.Fprintf(deps.Stdout, "\n%s debug is now disabled.\n", scope)
		}
		return ExitOK
	case "status":
		view, code := debugGetSettings(deps)
		if code != ExitOK {
			return code
		}
		debugPrintScopeStatus(scope, view, deps)
		return ExitOK
	case "reset":
		// TS writes the CLI scope name as the reset value ({reset:"provider"}
		// for the provider scope); the upstream ternary is pointless too, so
		// keep the wire value identical without mirroring the dead branch.
		resetKey := scope
		view, code := debugPutSettings(deps, fmt.Sprintf(`{"reset":%s}`, quoteJSONString(resetKey)))
		if code != ExitOK {
			return code
		}
		debugPrintScopeStatus(scope, view, deps)
		fmt.Fprintf(deps.Stdout, "\nRuntime override cleared for %s; effective value follows env again.\n", scope)
		return ExitOK
	case "logs":
		if !flag.hasLogs {
			if scope == "claude" {
				fmt.Fprintln(deps.Stderr, "Use: ocx observe claude-inbound")
			} else {
				fmt.Fprintln(deps.Stderr, "Injection debug has no buffered log stream; use: ocx observe injection")
			}
			return ExitFailure
		}
		follow := false
		for _, arg := range actionArgv[1:] {
			if arg == "-f" || arg == "--follow" {
				follow = true
			}
		}
		if scope == "provider" {
			return debugPrintProviderLogs(follow, deps)
		}
		return debugPrintUsageLogs(follow, deps)
	default:
		if !flag.hasLogs {
			fmt.Fprintf(deps.Stderr, "Usage: ocx debug %s on|off|status|reset\n", scope)
		} else {
			fmt.Fprintf(deps.Stderr, "Usage: ocx debug %s on|off|status|reset|logs [-f]\n", scope)
		}
		return ExitFailure
	}
}

// debugWireKey mirrors the PUT body key for each scope: only provider maps to
// the legacy `debug` flag.
func debugWireKey(scope string) string {
	if scope == "provider" {
		return "debug"
	}
	return scope
}

// debugLive mirrors requireLiveProxy: discover the live proxy or fail with the
// exact TS message and exit code 1.
func debugLive(deps Deps) (RuntimeState, bool) {
	deps = defaults(deps)
	if state, ok := liveProxyEndpoint(deps); ok {
		return state, true
	}
	fmt.Fprintln(deps.Stderr, "Proxy is not running. Start it with: ocx start")
	return RuntimeState{}, false
}

// debugRequest performs one raw authenticated management fetch. doErr is the
// transport/read error, or nil when the server answered.
func debugRequest(deps Deps, state RuntimeState, method, path string, body string) (raw []byte, status int, doErr error) {
	request, err := http.NewRequest(method, baseURL(state)+path, nil)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	if body != "" {
		request.Body = io.NopCloser(strings.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	if token := configuredUsageAdminToken(); token != "" {
		request.Header.Set("X-OpenCodex-API-Key", token)
	}
	response, doErr := deps.HTTPClient.Do(request)
	if doErr != nil {
		return nil, 0, doErr
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if readErr != nil {
		return nil, 0, readErr
	}
	return raw, response.StatusCode, nil
}

// debugGetSettings mirrors fetchDebugSettings: GET /api/debug, "Failed to read
// debug settings (<status>)" on non-OK, and the unreachable wording on a
// transport or JSON failure.
func debugGetSettings(deps Deps) (*jsonwire.Value, int) {
	state, ok := debugLive(deps)
	if !ok {
		return nil, ExitFailure
	}
	raw, status, err := debugRequest(deps, state, "GET", "/api/debug", "")
	if err != nil {
		fmt.Fprintf(deps.Stderr, "Proxy is running but /api/debug is unreachable: %s\n", err)
		return nil, ExitFailure
	}
	if status < 200 || status >= 300 {
		fmt.Fprintf(deps.Stderr, "Failed to read debug settings (%d)\n", status)
		return nil, ExitFailure
	}
	view, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		fmt.Fprintf(deps.Stderr, "Proxy is running but /api/debug is unreachable: %s\n", parseErr)
		return nil, ExitFailure
	}
	return view, ExitOK
}

// debugPutSettings mirrors putDebugSettings: PUT /api/debug. The non-OK text
// appends the first 200 characters of the body when one exists.
func debugPutSettings(deps Deps, body string) (*jsonwire.Value, int) {
	state, ok := debugLive(deps)
	if !ok {
		return nil, ExitFailure
	}
	raw, status, err := debugRequest(deps, state, "PUT", "/api/debug", body)
	if err != nil {
		// TS putDebugSettings has no catch: a transport failure rejects the
		// command promise. The differential never exercises this path (the
		// fixture server is reachable), so fail with code 1 and no invented
		// message.
		return nil, ExitFailure
	}
	if status < 200 || status >= 300 {
		suffix := ""
		text := string(raw)
		if text != "" {
			suffix = ": " + firstRunes(text, 200)
		}
		fmt.Fprintf(deps.Stderr, "Failed to update debug settings (%d)%s\n", status, suffix)
		return nil, ExitFailure
	}
	view, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		return nil, ExitFailure
	}
	return view, ExitOK
}

func firstRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// debugPrintScopeStatus mirrors printScopeStatus in src/cli/debug.ts.
func debugPrintScopeStatus(scope string, view *jsonwire.Value, deps Deps) {
	flag := debugFlags[scope]
	fmt.Fprintf(deps.Stdout, "%s debug: %s\n", flag.title, boolUpper(debugBoolField(view, flag.overallKey)))
	// env and runtimeOverride use the settings member key (provider → `debug`),
	// not the CLI scope name.
	key := debugWireKey(scope)
	envValue := debugNestedBool(view, "env", key)
	fmt.Fprintf(deps.Stdout, "  env=%s, runtime=%s\n", boolWord(envValue), debugRuntimeText(view, key))
	switch scope {
	case "provider":
		fmt.Fprintln(deps.Stdout, "  Tail: ocx debug provider logs [-f]")
	case "usage":
		fmt.Fprintln(deps.Stdout, "  Tail: ocx debug usage logs [-f] (via running proxy API)")
	case "injection":
		fmt.Fprintln(deps.Stdout, "  Lines appear on the proxy console when multi-agent guidance is injected.")
	case "claude":
		fmt.Fprintln(deps.Stdout, "  View: ocx observe claude-inbound")
	}
}

func boolUpper(value bool) string {
	if value {
		return "ON"
	}
	return "off"
}

func debugBoolField(view *jsonwire.Value, key string) bool {
	if view == nil {
		return false
	}
	field := view.Find(key)
	return field != nil && field.Kind() == jsonwire.Bool && field.Bool()
}

func debugNestedBool(view *jsonwire.Value, section, key string) bool {
	if view == nil {
		return false
	}
	container := view.Find(section)
	if container == nil || container.Kind() != jsonwire.Object {
		return false
	}
	field := container.Find(key)
	return field != nil && field.Kind() == jsonwire.Bool && field.Bool()
}

// debugRuntimeText mirrors the runtimeOverride tri-state: an absent member is
// "env/default", a boolean is on/off.
func debugRuntimeText(view *jsonwire.Value, key string) string {
	if view == nil {
		return "env/default"
	}
	container := view.Find("runtimeOverride")
	if container == nil || container.Kind() != jsonwire.Object {
		return "env/default"
	}
	field := container.Find(key)
	if field == nil {
		return "env/default"
	}
	if field.Kind() != jsonwire.Bool {
		return "env/default"
	}
	return boolWord(field.Bool())
}

// ─────────────────────────────────────────────────────────────────────────────
// log-stream rendering — port of printProviderLogs/printUsageLogs.

func debugPrintProviderLogs(follow bool, deps Deps) int {
	state, ok := debugLive(deps)
	if !ok {
		return ExitFailure
	}
	after, code := debugPrintLogBatch(deps, state, "/api/debug/logs", 0)
	if code != ExitOK {
		return code
	}
	for follow {
		time.Sleep(time.Second)
		newAfter, _ := debugPrintLogBatch(deps, state, "/api/debug/logs", after)
		if newAfter > after {
			after = newAfter
		}
	}
	return ExitOK
}

func debugPrintUsageLogs(follow bool, deps Deps) int {
	state, ok := debugLive(deps)
	if !ok {
		return ExitFailure
	}
	after, code := debugPrintLogBatch(deps, state, "/api/debug/usage-logs", 0)
	if code != ExitOK {
		return code
	}
	for follow {
		time.Sleep(time.Second)
		newAfter, _ := debugPrintLogBatch(deps, state, "/api/debug/usage-logs", after)
		if newAfter > after {
			after = newAfter
		}
	}
	return ExitOK
}

// debugPrintLogBatch fetches one batch and prints each entry line, returning
// the last seq for the follow loop. The first usage poll prints the empty hint
// when no entries exist; follow-loop polls swallow failures like the TS loop.
func debugPrintLogBatch(deps Deps, state RuntimeState, path string, after int) (int, int) {
	query := "?limit=500"
	if after > 0 {
		query = fmt.Sprintf("?after=%d&limit=500", after)
	}
	raw, status, err := debugRequest(deps, state, "GET", path+query, "")
	if err != nil {
		if after == 0 {
			fmt.Fprintf(deps.Stderr, "Failed to read debug logs: %s\n", err)
		}
		return after, ExitFailure
	}
	if status < 200 || status >= 300 {
		if after == 0 {
			fmt.Fprintf(deps.Stderr, "Failed to read debug logs (%d)\n", status)
		}
		return after, ExitFailure
	}
	entries, parseErr := jsonwire.Parse(raw)
	if parseErr != nil {
		if after == 0 {
			fmt.Fprintf(deps.Stderr, "Failed to read debug logs: %s\n", parseErr)
		}
		return after, ExitFailure
	}
	last := after
	count := 0
	if entries != nil && entries.Kind() == jsonwire.Array {
		for _, element := range entries.Elements() {
			if element == nil || element.Kind() != jsonwire.Object {
				continue
			}
			fmt.Fprintln(deps.Stdout, fieldString(element, "line"))
			count++
			if seqField := element.Find("seq"); seqField != nil && seqField.Kind() == jsonwire.Number {
				if number, ok := parseJSONNumber(seqField.NumberRaw()); ok {
					last = int(number)
				}
			}
		}
	}
	if count == 0 && after == 0 && strings.HasSuffix(path, "usage-logs") {
		fmt.Fprintln(deps.Stdout, "(empty — enable with: ocx debug usage on)")
	}
	return last, ExitOK
}
