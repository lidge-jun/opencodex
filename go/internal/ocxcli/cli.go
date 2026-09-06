// Package ocxcli owns the Go CLI scaffold for ADR-0008.
package ocxcli

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const (
	ExitOK                     = 0
	ExitFailure                = 1
	ExitUsage                  = 64
	configWriteUsageExit       = 2
	attestationChallengeHeader = "x-opencodex-attestation-challenge"
	attestationProofHeader     = "x-opencodex-attestation-proof"
)

// Ownership identifies the runtime that implements a documented command.
// TypeScriptOwned is an explicit migration seam, not a claim that Go owns the
// command merely because the Go binary forwards it.
type Ownership string

const (
	GoOwned         Ownership = "go-owned"
	TypeScriptOwned Ownership = "typescript-owned"
)

// Command is one user-visible top-level command. Commands is the Go CLI's
// machine-readable surface map: fullUsage, dispatch, and CI tests are all
// reconciled against it. Aliases resolve to the same owner as their command.
type Command struct {
	Name, Usage, Summary string
	Aliases              []string
	Owner                Ownership
}

var Commands = []Command{
	{Name: "setup", Aliases: []string{"init"}, Usage: "ocx setup", Summary: "Interactive setup.", Owner: TypeScriptOwned},
	{Name: "start", Usage: "ocx start [--port <port>]", Summary: "Start the proxy.", Owner: TypeScriptOwned},
	{Name: "stop", Usage: "ocx stop", Summary: "Stop the proxy.", Owner: TypeScriptOwned},
	{Name: "restore", Aliases: []string{"eject"}, Usage: "ocx restore [back]", Summary: "Restore native Codex configuration.", Owner: TypeScriptOwned},
	{Name: "recover-history", Usage: "ocx recover-history --legacy-openai --yes", Summary: "Recover legacy history.", Owner: TypeScriptOwned},
	{Name: "uninstall", Aliases: []string{"remove"}, Usage: "ocx uninstall", Summary: "Remove OpenCodex integration.", Owner: TypeScriptOwned},
	{Name: "service", Usage: "ocx service [sub]", Summary: "Run as a background service.", Owner: TypeScriptOwned},
	{Name: "codex-shim", Usage: "ocx codex-shim <sub>", Summary: "Manage the Codex autostart shim.", Owner: TypeScriptOwned},
	{Name: "tray", Usage: "ocx tray <sub>", Summary: "Manage the Windows status tray.", Owner: TypeScriptOwned},
	{Name: "ensure", Usage: "ocx ensure", Summary: "Ensure the proxy is running.", Owner: TypeScriptOwned},
	{Name: "connect", Usage: "ocx connect <url>", Summary: "Connect to a remote hub.", Owner: TypeScriptOwned},
	{Name: "disconnect", Usage: "ocx disconnect", Summary: "Disconnect from a remote hub.", Owner: TypeScriptOwned},
	{Name: "sync", Usage: "ocx sync [--restart-codex]", Summary: "Sync provider models.", Owner: TypeScriptOwned},
	{Name: "sync-cache", Usage: "ocx sync-cache [--restart-codex]", Summary: "Refresh the model cache.", Owner: TypeScriptOwned},
	{Name: "status", Usage: "ocx status", Summary: "Check proxy status.", Owner: GoOwned},
	{Name: "doctor", Usage: "ocx doctor", Summary: "Diagnose the environment.", Owner: GoOwned},
	{Name: "debug", Usage: "ocx debug <scope>", Summary: "Manage debug settings.", Owner: TypeScriptOwned},
	{Name: "login", Usage: "ocx login <provider>", Summary: "Log in to a provider.", Owner: TypeScriptOwned},
	{Name: "logout", Usage: "ocx logout <provider>", Summary: "Log out from a provider.", Owner: TypeScriptOwned},
	{Name: "gui", Usage: "ocx gui", Summary: "Open the dashboard.", Owner: TypeScriptOwned},
	{Name: "update", Usage: "ocx update [--tag <tag>]", Summary: "Update OpenCodex.", Owner: TypeScriptOwned},
	{Name: "restart", Usage: "ocx restart", Summary: "Restart the proxy.", Owner: TypeScriptOwned},
	{Name: "v2", Usage: "ocx v2 <sub>", Summary: "Manage the v2 surface.", Owner: TypeScriptOwned},
	{Name: "health", Usage: "ocx health [--json]", Summary: "Verify the local proxy identity and report health.", Owner: GoOwned},
	{Name: "capabilities", Usage: "ocx capabilities [--json]", Summary: "List declared capabilities.", Owner: TypeScriptOwned},
	{Name: "ready", Usage: "ocx ready [--json] [--wait [--timeout <s>]]", Summary: "Verify readiness.", Owner: GoOwned},
	{Name: "provider", Usage: "ocx provider <sub>", Summary: "Inspect configured providers.", Owner: GoOwned},
	{Name: "account", Usage: "ocx account <sub>", Summary: "Manage accounts.", Owner: TypeScriptOwned},
	{Name: "models", Usage: "ocx models [--provider <name>] [--json]", Summary: "List configured models.", Owner: GoOwned},
	{Name: "alias", Usage: "ocx alias <sub>", Summary: "Manage aliases.", Owner: TypeScriptOwned},
	{Name: "combo", Usage: "ocx combo <sub>", Summary: "Manage combo routing.", Owner: TypeScriptOwned},
	{Name: "agent", Usage: "ocx agent <sub>", Summary: "Manage agents.", Owner: TypeScriptOwned},
	{Name: "observe", Usage: "ocx observe <sub>", Summary: "Inspect runtime observations.", Owner: TypeScriptOwned},
	{Name: "inspect", Usage: "ocx inspect <sub>", Summary: "Inspect effective state.", Owner: TypeScriptOwned},
	{Name: "route", Usage: "ocx route <sub>", Summary: "Manage routing.", Owner: TypeScriptOwned},
	{Name: "logs", Usage: "ocx logs [filters]", Summary: "Read logs.", Owner: TypeScriptOwned},
	{Name: "usage", Usage: "ocx usage", Summary: "Report usage.", Owner: TypeScriptOwned},
	{Name: "storage", Usage: "ocx storage <sub>", Summary: "Manage storage.", Owner: TypeScriptOwned},
	{Name: "memory", Usage: "ocx memory [--json]", Summary: "Inspect memory.", Owner: TypeScriptOwned},
	{Name: "api-key", Usage: "ocx api-key <sub>", Summary: "Manage API keys.", Owner: TypeScriptOwned},
	{Name: "access", Usage: "ocx access <sub>", Summary: "Manage external access.", Owner: TypeScriptOwned},
	{Name: "export", Usage: "ocx export --client <id>", Summary: "Export client configuration.", Owner: TypeScriptOwned},
	{Name: "integration", Usage: "ocx integration client <sub>", Summary: "Manage integrations.", Owner: TypeScriptOwned},
	{Name: "grok", Usage: "ocx grok <sub>", Summary: "Manage Grok Build.", Owner: TypeScriptOwned},
	{Name: "system", Usage: "ocx system <sub>", Summary: "Manage runtime settings.", Owner: TypeScriptOwned},
	// The full config family is Go-owned: reads project through the schema
	// normalizer and writes share the SQLite generation transaction.
	{Name: "config", Usage: "ocx config <sub>", Summary: "Manage configuration.", Owner: GoOwned},
	{Name: "lab", Usage: "ocx lab <sub>", Summary: "Inspect Compatibility Lab.", Owner: TypeScriptOwned},
	{Name: "claude", Usage: "ocx claude [args...]", Summary: "Launch Claude Code.", Owner: TypeScriptOwned},
	{Name: "opencode", Usage: "ocx opencode [args...]", Summary: "Launch opencode.", Owner: TypeScriptOwned},
	{Name: "mcode", Usage: "ocx mcode [args...]", Summary: "Launch MiniMax Code.", Owner: TypeScriptOwned},
	{Name: "mmx", Usage: "ocx mmx text <sub> [args]", Summary: "Launch MiniMax CLI.", Owner: TypeScriptOwned},
	{Name: "zcode", Usage: "ocx zcode [sub]", Summary: "Connect ZCode.", Owner: TypeScriptOwned},
}

// commandForName resolves canonical command names and aliases from Commands.
func commandForName(name string) (Command, bool) {
	for _, command := range Commands {
		if command.Name == name {
			return command, true
		}
		for _, alias := range command.Aliases {
			if alias == name {
				return command, true
			}
		}
	}
	return Command{}, false
}

// OwnershipFor reports the owner of argv's command surface. It is intentionally
// data-driven so a command cannot become native by accident while it still
// routes through DelegateToTypeScript.
func OwnershipFor(args []string) (Ownership, bool) {
	if len(args) == 0 {
		return GoOwned, true // Root help is emitted by this binary.
	}
	command, ok := commandForName(args[0])
	if !ok {
		return "", false
	}
	if command.Name == "models" && len(args) > 1 {
		if owner, ok := modelRuntimeSubcommands[args[1]]; ok {
			return owner, true
		}
	}
	if command.Name == "codex-shim" && len(args) > 1 {
		if args[1] == "status" {
			return GoOwned, true
		}
		return TypeScriptOwned, true
	}
	if command.Name == "config" && len(args) > 1 {
		if args[1] == "--json" || args[1] == "--source" {
			return GoOwned, true
		}
		if owner, ok := configRuntimeSubcommands[args[1]]; ok {
			return owner, true
		}
		return TypeScriptOwned, true
	}
	return command.Owner, true
}

type RuntimeState struct {
	PID               int64  `json:"pid"`
	Port              int    `json:"port"`
	Hostname          string `json:"hostname"`
	AttestationSecret string `json:"attestationSecret"`
}

type Health struct {
	Status  string  `json:"status"`
	Service string  `json:"service"`
	Version string  `json:"version"`
	Uptime  float64 `json:"uptime"`
	PID     int64   `json:"pid"`
	Port    int     `json:"port"`
}
type readiness struct {
	Service string  `json:"service"`
	Version string  `json:"version"`
	Uptime  float64 `json:"uptime"`
	PID     int64   `json:"pid"`
	Port    int     `json:"port"`
	Status  string  `json:"status"`
}

type Deps struct {
	Version        string
	Stdout, Stderr io.Writer
	ReadRuntime    func() (RuntimeState, error)
	HTTPClient     *http.Client
	Challenge      func() (string, error)
	// Delegate runs a TypeScript-owned lifecycle command.  It is deliberately
	// injected: these commands own OS registrations and Codex launch paths, and
	// the Go command must preserve both their transaction and their exact output.
	Delegate func([]string) (int, error)
}

func defaults(d Deps) Deps {
	if d.Stdout == nil {
		d.Stdout = os.Stdout
	}
	if d.Stderr == nil {
		d.Stderr = os.Stderr
	}
	if d.ReadRuntime == nil {
		d.ReadRuntime = ReadRuntime
	}
	if d.HTTPClient == nil {
		d.HTTPClient = &http.Client{Timeout: 750 * time.Millisecond}
	}
	if d.Challenge == nil {
		d.Challenge = CreateChallenge
	}
	if d.Delegate == nil {
		d.Delegate = DelegateToTypeScript
	}
	return d
}

// Run dispatches a parsed argv and returns a POSIX-style process code.
func Run(args []string, deps Deps) int {
	deps = defaults(deps)
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		printHelp(deps.Stdout)
		return ExitOK
	}
	if args[0] == "help" {
		if len(args) > 1 {
			return printSubcommandHelp(args[1], deps)
		}
		printHelp(deps.Stdout)
		return ExitOK
	}
	if hasHelpFlag(args[1:]) {
		return printSubcommandHelp(args[0], deps)
	}
	switch args[0] {
	case "--version", "-v", "version":
		fmt.Fprintf(deps.Stdout, "opencodex %s\n", deps.Version)
		return ExitOK
	}
	owner, known := OwnershipFor(args)
	if !known {
		fmt.Fprintf(deps.Stderr, "Unknown command: %s\n", args[0])
		printHelp(deps.Stdout)
		return ExitFailure
	}
	if owner == TypeScriptOwned {
		return runDelegated(args, deps)
	}
	switch args[0] {
	case "codex-shim":
		return runCodexShim(args[1:], deps)
	case "health":
		return runHealth(args[1:], deps)
	case "ready":
		return runReady(args[1:], deps)
	case "models":
		return runModels(args[1:], deps)
	case "provider":
		return runProvider(args[1:], deps)
	case "config":
		return runConfig(args[1:], deps)
	case "status":
		return runStatus(args[1:], deps)
	case "doctor":
		return RunDoctorCommand(args[1:], deps.Stdout, deps.Stderr, DoctorCommandDeps{})
	default:
		// The ownership registry above and this switch must be reconciled by
		// TestOwnershipMapMatchesDispatch; this is defensive for future edits.
		fmt.Fprintf(deps.Stderr, "Unimplemented Go-owned command: %s\n", args[0])
		return ExitFailure
	}
}

// runDelegated is the ownership seam for commands whose correctness depends on
// TypeScript's established file transactions and platform service integrations.
// Inheriting stdout and stderr gives the Go binary byte-for-byte parity and, more
// importantly, prevents a second implementation from bypassing ownership checks.
func runDelegated(args []string, deps Deps) int {
	code, err := deps.Delegate(args)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	return code
}

func printHelp(w io.Writer) { fmt.Fprint(w, fullUsage) }
func hasHelpFlag(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" || arg == "help" {
			return true
		}
	}
	return false
}
func printSubcommandHelp(name string, deps Deps) int {
	if name == "config" {
		fmt.Fprint(deps.Stdout, configHelp)
		return ExitOK
	}
	if owner, known := OwnershipFor([]string{name}); known && owner == TypeScriptOwned {
		return runDelegated([]string{name, "--help"}, deps)
	}
	switch name {
	case "doctor":
		fmt.Fprint(deps.Stdout, "Usage: ocx doctor\n\nDiagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability).\n\nDefault mode is observe-only and reports the native-write coordinator state and exact path.\nAfter stopping the proxy/service, `--recover-zero-byte-coordinator --yes` moves only a proven zero-byte coordinator to a same-directory backup.\n")
	case "status":
		fmt.Fprint(deps.Stdout, "Usage: ocx status\n\nCheck proxy server status.\n")
	case "health":
		fmt.Fprint(deps.Stdout, "Usage: ocx health [--json]\n\nCheck proxy health. Exits 0 if healthy, 1 otherwise.\n\nUse --json for structured output: {ok, pid, port}.\n")
	case "ready":
		fmt.Fprint(deps.Stdout, "Usage: ocx ready [--json] [--wait [--timeout <seconds>]]\n\nCheck post-sync readiness. Exits 0 only when ready.\n\nExact unauthenticated GET /readyz returns HTTP 200 when ready, or 503 with Retry-After: 1 for pending or failed.\nIts sanitized HTTP identity is {service, version, uptime, pid, port, status}; /healthz is separate liveness, not readiness.\nDefault is a single identity-checked /readyz probe; old proxies without /readyz fail closed as unreachable.\n--wait polls until ready or timeout, but exits immediately on terminal failed (default 45s, max 300s).\n--timeout requires --wait and accepts a positive integer (1..300).\n--json emits {ready, status, pid, port}; status is one of ready|pending|failed|unreachable.\nInvalid or unknown arguments exit 64. Not-ready, pending, failed, timeout, and unreachable exit 1.\n")
	case "models":
		fmt.Fprint(deps.Stdout, modelsUsage+"\nCustom models:\n  "+modelAddUsage+"\n  "+modelRemoveUsage+"\n  Usage: ocx models list-custom [--json]\n\nRuntime subcommands (live, edit, enable, disable, provider, selected, preset, new-policy, new-arrivals, context, shadow) retain the TypeScript management API owner during the incremental takeover.\n")
	case "config":
		fmt.Fprint(deps.Stdout, configHelp)
	default:
		fmt.Fprintf(deps.Stderr, "Unknown command: %s\n", name)
		printHelp(deps.Stdout)
		return ExitFailure
	}
	return ExitOK
}
func runHealth(args []string, deps Deps) int {
	jsonOutput := false
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		}
	}
	health, _, err := ProbeHealth(deps)
	if err != nil {
		if jsonOutput {
			fmt.Fprintln(deps.Stdout, "{\"ok\":false,\"pid\":null,\"port\":null}")
		} else {
			fmt.Fprintln(deps.Stdout, "Proxy not healthy")
		}
		return ExitFailure
	}
	if jsonOutput {
		fmt.Fprintf(deps.Stdout, "{\"ok\":true,\"pid\":%d,\"port\":%d}\n", health.PID, health.Port)
	} else {
		fmt.Fprintf(deps.Stdout, "Proxy healthy (PID %d, port %d)\n", health.PID, health.Port)
	}
	return ExitOK
}

type readyArgs struct {
	json, wait, hasTimeout bool
	timeout                time.Duration
}

func parseReady(args []string) (readyArgs, bool) {
	parsed := readyArgs{timeout: 45 * time.Second}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			parsed.json = true
		case "--wait":
			parsed.wait = true
		case "--timeout":
			if i+1 >= len(args) {
				return readyArgs{}, false
			}
			seconds, err := strconv.Atoi(args[i+1])
			if err != nil || seconds < 1 || seconds > 300 {
				return readyArgs{}, false
			}
			parsed.timeout = time.Duration(seconds) * time.Second
			parsed.hasTimeout = true
			i++
		default:
			return readyArgs{}, false
		}
	}
	if parsed.hasTimeout && !parsed.wait {
		return readyArgs{}, false
	}
	return parsed, true
}
func runReady(args []string, deps Deps) int {
	parsed, ok := parseReady(args)
	if !ok {
		fmt.Fprintln(deps.Stderr, "Usage: ocx ready [--json] [--wait [--timeout <seconds>]]")
		fmt.Fprintln(deps.Stderr, "  --timeout requires --wait; <seconds> must be a positive integer (1..300).")
		fmt.Fprintln(deps.Stderr, "  Default wait timeout is 45 seconds.")
		return ExitUsage
	}
	deadline := time.Now().Add(parsed.timeout)
	for {
		_, _, err := ProbeHealth(deps)
		if err != nil {
			return reportReady(deps, parsed.json, false, "unreachable", 0, 0)
		}
		state, err := deps.ReadRuntime()
		if err != nil {
			return reportReady(deps, parsed.json, false, "unreachable", 0, 0)
		}
		ready, err := ProbeReady(state, deps.HTTPClient)
		if err != nil {
			return reportReady(deps, parsed.json, false, "unreachable", 0, 0)
		}
		if ready.Status != "pending" || !parsed.wait || time.Now().Add(500*time.Millisecond).After(deadline) {
			return reportReady(deps, parsed.json, ready.Status == "ready", ready.Status, ready.PID, ready.Port)
		}
		time.Sleep(500 * time.Millisecond)
	}
}
func reportReady(deps Deps, jsonOutput bool, isReady bool, status string, pid int64, port int) int {
	if jsonOutput {
		if status == "unreachable" {
			fmt.Fprintln(deps.Stdout, "{\"ready\":false,\"status\":\"unreachable\",\"pid\":null,\"port\":null}")
		} else {
			fmt.Fprintf(deps.Stdout, "{\"ready\":%t,\"status\":%q,\"pid\":%d,\"port\":%d}\n", isReady, status, pid, port)
		}
	} else if isReady {
		fmt.Fprintf(deps.Stdout, "Proxy ready (PID %d, port %d)\n", pid, port)
	} else if status == "pending" {
		fmt.Fprintln(deps.Stdout, "Proxy running but not ready yet (pending).")
	} else if status == "failed" {
		fmt.Fprintln(deps.Stdout, "Proxy running but not ready (sync failed).")
	} else {
		fmt.Fprintln(deps.Stdout, "Proxy not reachable or readiness unavailable.")
	}
	if isReady {
		return ExitOK
	}
	return ExitFailure
}

// ReadRuntime reads the TypeScript-owned runtime record. It accepts exactly the
// fields needed to bind a proof to the recorded process and listener.
func ReadRuntime() (RuntimeState, error) {
	dir, err := config.Dir()
	if err != nil {
		return RuntimeState{}, err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "runtime-port.json"))
	if err != nil {
		return RuntimeState{}, err
	}
	var state RuntimeState
	if err := json.Unmarshal(raw, &state); err != nil {
		return RuntimeState{}, err
	}
	if state.PID <= 0 || state.Port < 1 || state.Port > 65535 || !managementauth.IsAttestationSecret(state.AttestationSecret) {
		return RuntimeState{}, errors.New("invalid runtime record")
	}
	if state.Hostname == "localhost" {
		state.Hostname = "127.0.0.1"
	}
	return state, nil
}
func probeHost(hostname string) string {
	host := strings.TrimSpace(hostname)
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		return "127.0.0.1"
	}
	return strings.Trim(host, "[]")
}
func baseURL(state RuntimeState) string {
	host := probeHost(state.Hostname)
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return "http://" + host + ":" + strconv.Itoa(state.Port)
}

// CreateChallenge matches createLocalAttestationChallenge in TypeScript.
func CreateChallenge() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// ProbeHealth verifies public identity plus the proof bound to the protected runtime record. No admin token is sent.
func ProbeHealth(deps Deps) (Health, []byte, error) {
	deps = defaults(deps)
	state, err := deps.ReadRuntime()
	if err != nil {
		return Health{}, nil, err
	}
	challenge, err := deps.Challenge()
	if err != nil {
		return Health{}, nil, err
	}
	req, err := http.NewRequest(http.MethodGet, baseURL(state)+"/healthz", nil)
	if err != nil {
		return Health{}, nil, err
	}
	req.Header.Set(attestationChallengeHeader, challenge)
	response, err := deps.HTTPClient.Do(req)
	if err != nil {
		return Health{}, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return Health{}, nil, err
	}
	var health Health
	if response.StatusCode != http.StatusOK || json.Unmarshal(raw, &health) != nil || health.Status != "ok" || health.Service != "opencodex" || health.Version == "" || health.Uptime < 0 || health.PID != state.PID || health.Port != state.Port || !managementauth.VerifyLocalAttestationProof(state.AttestationSecret, challenge, state.PID, state.Port, response.Header.Get(attestationProofHeader)) {
		return Health{}, nil, errors.New("unattested or foreign proxy")
	}
	return health, raw, nil
}

// ProbeReady applies the strict TypeScript /readyz wire contract after health was attested.
func ProbeReady(state RuntimeState, client *http.Client) (readiness, error) {
	response, err := client.Get(baseURL(state) + "/readyz")
	if err != nil {
		return readiness{}, err
	}
	defer response.Body.Close()
	var body readiness
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&body); err != nil {
		return readiness{}, err
	}
	if body.Service != "opencodex" || body.Version == "" || body.Uptime < 0 || body.PID != state.PID || body.Port != state.Port || (body.Status != "ready" && body.Status != "pending" && body.Status != "failed") || (body.Status == "ready" && response.StatusCode != http.StatusOK) || (body.Status != "ready" && response.StatusCode != http.StatusServiceUnavailable) {
		return readiness{}, errors.New("invalid readiness response")
	}
	return body, nil
}
