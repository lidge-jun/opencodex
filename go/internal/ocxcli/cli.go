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
	attestationChallengeHeader = "x-opencodex-attestation-challenge"
	attestationProofHeader     = "x-opencodex-attestation-proof"
)

// Command is one user-visible top-level command. Keeping the registry data
// separate makes later parity additions additive and unit-testable.
type Command struct{ Name, Usage, Summary string }

var Commands = []Command{
	{Name: "health", Usage: "ocx health [--json]", Summary: "Verify the local proxy identity and report health."},
	{Name: "ready", Usage: "ocx ready [--json]", Summary: "Verify the local proxy identity and report readiness."},
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
	return d
}

// Run dispatches a parsed argv and returns a POSIX-style process code.
func Run(args []string, deps Deps) int {
	deps = defaults(deps)
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printHelp(deps.Stdout)
		return ExitOK
	}
	switch args[0] {
	case "--version", "-v", "version":
		fmt.Fprintf(deps.Stdout, "opencodex %s\n", deps.Version)
		return ExitOK
	case "health":
		return runHealth(args[1:], deps)
	case "ready":
		return runReady(args[1:], deps)
	default:
		fmt.Fprintf(deps.Stderr, "Unknown command: %s\n", args[0])
		printHelp(deps.Stderr)
		return ExitUsage
	}
}

func printHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage: ocx <command>\n\nCommands:")
	for _, c := range Commands {
		fmt.Fprintf(w, "  %-24s %s\n", c.Usage, c.Summary)
	}
	fmt.Fprintln(w, "  ocx --version | -v       Print version")
}
func parseJSON(args []string) (bool, bool) {
	if len(args) == 0 {
		return false, true
	}
	return len(args) == 1 && args[0] == "--json", len(args) == 1 && args[0] == "--json"
}

func runHealth(args []string, deps Deps) int {
	jsonOutput, ok := parseJSON(args)
	if !ok {
		fmt.Fprintln(deps.Stderr, "Usage: ocx health [--json]")
		return ExitUsage
	}
	health, raw, err := ProbeHealth(deps)
	if err != nil {
		fmt.Fprintf(deps.Stderr, "Proxy health check failed: %v\n", err)
		return ExitFailure
	}
	if jsonOutput {
		fmt.Fprintln(deps.Stdout, string(raw))
	} else {
		fmt.Fprintf(deps.Stdout, "Proxy healthy (PID %d, port %d, version %s)\n", health.PID, health.Port, health.Version)
	}
	return ExitOK
}
func runReady(args []string, deps Deps) int {
	jsonOutput, ok := parseJSON(args)
	if !ok {
		fmt.Fprintln(deps.Stderr, "Usage: ocx ready [--json]")
		return ExitUsage
	}
	health, _, err := ProbeHealth(deps)
	if err != nil {
		return reportReady(deps, jsonOutput, false, "unreachable", 0, 0)
	}
	state, err := deps.ReadRuntime()
	if err != nil {
		return reportReady(deps, jsonOutput, false, "unreachable", health.PID, health.Port)
	}
	ready, err := ProbeReady(state, deps.HTTPClient)
	if err != nil {
		return reportReady(deps, jsonOutput, false, "unreachable", health.PID, health.Port)
	}
	return reportReady(deps, jsonOutput, ready.Status == "ready", ready.Status, ready.PID, ready.Port)
}
func reportReady(deps Deps, jsonOutput bool, isReady bool, status string, pid int64, port int) int {
	if jsonOutput {
		fmt.Fprintf(deps.Stdout, "{\"ready\":%t,\"status\":%q,\"pid\":%d,\"port\":%d}\n", isReady, status, pid, port)
	} else if isReady {
		fmt.Fprintf(deps.Stdout, "Proxy ready (PID %d, port %d)\n", pid, port)
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
