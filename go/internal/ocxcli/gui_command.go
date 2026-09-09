package ocxcli

// ocx gui — open the opencodex dashboard or mint a bound remote pairing grant
// (issue #54 ops slice). This file ports the TypeScript owner
// (src/cli/gui.ts + the dispatch openDefaultGui wiring + src/cli/gui-pair-client.ts)
// so the ownership flip keeps the documented surface identical: the same usage
// rejections, the same hub-origin gate, the same HMAC-bound pairing capability
// request, and the same browser-open path.
//
// Exit codes mirror the TS command: usage mistakes exit 1 (not the runCliAction
// 2), pairing failures exit 1, and a bare `ocx gui` starts the proxy when
// needed and opens the dashboard URL.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/config"
	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

var osRuntime = runtime.GOOS

const (
	guiUsage           = "ocx gui [pair --origin <browser-origin> [--json]]"
	guiPairingWarning  = "Pairing grants are secret, single-use, and expire quickly. Do not save them."
	guiPairMethod      = "POST"
	guiPairPath        = "/api/gui/pairing-grants"
	guiPairCapabilityV = "v1"
	guiPairTTLMS       = 10_000
	guiPairRequestMS   = 10_000
)

// pairingHTTPClient mirrors the TS pairing flow's 10 s abort window
// (AbortSignal.timeout(10_000) in src/cli/gui-pair-client.ts). Discovery and
// the readiness probes may keep the fast 750 ms default client, but the two
// pairing hops (attestation healthz + grant POST) must tolerate a management
// plane that answers in up to 10 s; the transport is shared so loopback
// behavior stays identical.
func pairingHTTPClient(deps Deps) *http.Client {
	return &http.Client{Timeout: guiPairRequestMS * time.Millisecond, Transport: deps.HTTPClient.Transport}
}

// guiHelp mirrors the registry-derived help the TypeScript CLI prints for
// `ocx help gui` / `ocx gui --help` (printSubcommandUsage).
const guiHelp = "Usage: ocx gui [pair --origin <browser-origin> [--json]]\n\nOpen the opencodex dashboard or create a secret single-use remote pairing grant.\n\nPairing requires an explicit allowed --origin; there is no localhost or config-derived default.\nThe printed grant is secret, single-use, short-lived, and must not be persisted.\n"

// guiConfig carries the OcxConfig projection the pairing gate reads. Mirroring
// the TS loadConfig defaults: absent keys read as the zod defaults (runtimeRole
// absent = standalone, corsAllowOrigins absent = empty).
type guiConfig struct {
	runtimeRole              string
	managementPublicOrigin   string
	corsAllowOrigins         []string
	port                     int
	hostname                 string
	hubManagementPublicKnown bool
}

func readGuiConfig() guiConfig {
	cfg := guiConfig{port: 10100}
	loaded, err := config.Load()
	if err != nil || loaded == nil {
		return cfg
	}
	raw := loaded.Raw
	if value, ok := raw["runtimeRole"].(string); ok {
		cfg.runtimeRole = value
	}
	if hub, ok := raw["hub"].(map[string]any); ok {
		if origin, ok := hub["managementPublicOrigin"].(string); ok {
			cfg.hubManagementPublicKnown = true
			cfg.managementPublicOrigin = origin
		}
	}
	if list, ok := raw["corsAllowOrigins"].([]any); ok {
		for _, entry := range list {
			if value, ok := entry.(string); ok {
				cfg.corsAllowOrigins = append(cfg.corsAllowOrigins, value)
			}
		}
	}
	if port, ok := raw["port"].(json.Number); ok {
		if parsed, err := port.Int64(); err == nil && parsed > 0 && parsed <= 65535 {
			cfg.port = int(parsed)
		}
	}
	if hostname, ok := raw["hostname"].(string); ok {
		cfg.hostname = hostname
	}
	return cfg
}

// canonicalGuiBrowserOrigin mirrors canonicalGuiBrowserOrigin in
// src/lib/gui-pair-capability.ts. Only a trimmed string that URL-parses with a
// host, no credentials/query/fragment and no (or root) path is canonical; http(s)
// origins drop their default port and lowercase the host (WHATWG origin rules).
func canonicalGuiBrowserOrigin(value string) string {
	if value != strings.TrimSpace(value) {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	path := parsed.EscapedPath()
	if path != "" && path != "/" {
		return ""
	}
	host := lowerBracketHost(parsed)
	scheme := strings.ToLower(parsed.Scheme)
	if scheme == "http" || scheme == "https" {
		return hostOrigin(scheme, parsed)
	}
	return scheme + "://" + host
}

// canonicalHttpOrigin mirrors the http(s)-only canonicalisation the pairing
// client applies to a created grant's serverOrigin.
func canonicalHttpOrigin(value string) string {
	if value != strings.TrimSpace(value) {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	path := parsed.EscapedPath()
	if path != "" && path != "/" {
		return ""
	}
	return hostOrigin(scheme, parsed)
}

func hostOrigin(scheme string, parsed *url.URL) string {
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return ""
	}
	if strings.Contains(hostname, ":") && !strings.HasPrefix(hostname, "[") {
		hostname = "[" + hostname + "]"
	}
	port := parsed.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		return scheme + "://" + hostname + ":" + port
	}
	return scheme + "://" + hostname
}

// lowerBracketHost returns the bracketed hostname plus any non-default port,
// mirroring URL.host (used by the TS canonicaliser for non-http(s) schemes).
func lowerBracketHost(parsed *url.URL) string {
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return ""
	}
	if strings.Contains(hostname, ":") && !strings.HasPrefix(hostname, "[") {
		hostname = "[" + hostname + "]"
	}
	if parsed.Port() != "" {
		return hostname + ":" + parsed.Port()
	}
	return hostname
}

func allowedGuiPairingOrigin(origin string, cfg guiConfig) bool {
	if cfg.runtimeRole != "hub" {
		return false
	}
	if cfg.hubManagementPublicKnown && canonicalGuiBrowserOrigin(cfg.managementPublicOrigin) == origin {
		return true
	}
	for _, value := range cfg.corsAllowOrigins {
		if canonicalGuiBrowserOrigin(value) == origin {
			return true
		}
	}
	return false
}

type guiPairArgs struct {
	origin string
	json   bool
}

// parseGuiPairArgs mirrors parsePairArgs: `--json` at most once and `--origin
// <value>` at most once with a value that is not itself a flag; anything else
// (including a repeated flag) makes the whole argv invalid.
func parseGuiPairArgs(args []string) *guiPairArgs {
	var origin string
	jsonOutput := false
	originSeen := false
	jsonSeen := false
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--json" && !jsonSeen:
			jsonSeen = true
			jsonOutput = true
		case arg == "--origin" && !originSeen:
			if index+1 >= len(args) {
				return nil
			}
			value := args[index+1]
			if strings.HasPrefix(value, "--") {
				return nil
			}
			origin = value
			originSeen = true
			index++
		default:
			return nil
		}
	}
	if origin == "" {
		return nil
	}
	return &guiPairArgs{origin: origin, json: jsonOutput}
}

// guiPairCreated mirrors the created branch of GuiPairRequestResult.
type guiPairCreated struct {
	grant         string
	browserOrigin string
	serverOrigin  string
	expiresAt     int64
}

var guiGrantPattern = regexp.MustCompile(`^ocx_pair_[A-Za-z0-9_-]{43}$`)

// sameGuiRuntime mirrors sameRuntime in gui-pair-client.ts: the record re-read
// after discovery must carry the same pid/port/hostname and an equal
// attestation secret for the pairing grant to proceed.
func sameGuiRuntime(left RuntimeState, right RuntimeState) bool {
	return right.AttestationSecret != "" &&
		right.PID == left.PID && right.Port == left.Port && right.Hostname == left.Hostname &&
		right.AttestationSecret == left.AttestationSecret
}

// requestGuiPairingGrant ports requestBoundGuiPairingGrant: read the runtime
// record again and require it to be the same live process, attest it against
// /healthz (challenge + proof), assert the guiPairCapability version, bind the
// capability HMAC to this request, and POST the pairing path. Reason strings
// match the TS unavailable reasons so failure output is byte-identical.
func requestGuiPairingGrant(state RuntimeState, browserOrigin string, deps Deps) (*guiPairCreated, string) {
	deps = defaults(deps)
	// A discovered proxy that is not the attested runtime process (config-fallback
	// or pid-less discovery) cannot carry the pairing capability.
	if state.PID <= 0 || state.Port < 1 || state.Port > 65535 {
		return nil, "unattested-target"
	}
	canonical := canonicalGuiBrowserOrigin(browserOrigin)
	if canonical == "" || canonical != browserOrigin {
		return nil, "capability"
	}
	reRead, readErr := deps.ReadRuntime()
	if readErr != nil || !sameGuiRuntime(state, reRead) {
		return nil, "runtime-mismatch"
	}
	challenge, err := deps.Challenge()
	if err != nil {
		return nil, "transport"
	}
	pairingClient := pairingHTTPClient(deps)
	request, err := http.NewRequest(http.MethodGet, baseURL(state)+"/healthz", nil)
	if err != nil {
		return nil, "transport"
	}
	request.Header.Set(attestationChallengeHeader, challenge)
	response, err := pairingClient.Do(request)
	if err != nil {
		return nil, "transport"
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if readErr != nil || response.StatusCode != http.StatusOK {
		return nil, "attestation"
	}
	body, parseErr := jsonwire.Parse(raw)
	if parseErr != nil || body.Kind() != jsonwire.Object {
		return nil, "attestation"
	}
	if !healthzPairingIdentity(body, state) {
		return nil, "attestation"
	}
	proof := response.Header.Get(attestationProofHeader)
	if !managementauth.VerifyLocalAttestationProof(state.AttestationSecret, challenge, state.PID, state.Port, proof) {
		return nil, "attestation"
	}
	if capability := body.Find("guiPairCapability"); capability == nil || capability.Kind() != jsonwire.String || capability.String() != guiPairCapabilityV {
		return nil, "capability"
	}
	// The proxy could have restarted between discovery and the proof round;
	// re-check that the runtime record is still the one we attested.
	reRead, readErr = deps.ReadRuntime()
	if readErr != nil || !sameGuiRuntime(state, reRead) {
		return nil, "runtime-mismatch"
	}
	expiresAt := time.Now().UnixMilli() + guiPairTTLMS
	capabilityToken := createGuiPairCapability(state.AttestationSecret, challenge, browserOrigin, state.PID, state.Port, expiresAt)
	if capabilityToken == "" {
		return nil, "capability"
	}
	pairRequest, err := http.NewRequest(guiPairMethod, baseURL(state)+guiPairPath, nil)
	if err != nil {
		return nil, "transport"
	}
	pairRequest.Header.Set("Content-Length", "0")
	pairRequest.Header.Set("x-opencodex-gui-pair-expected-pid", strconv.FormatInt(state.PID, 10))
	pairRequest.Header.Set("x-opencodex-gui-pair-nonce", challenge)
	pairRequest.Header.Set("x-opencodex-gui-pair-expires-at", strconv.FormatInt(expiresAt, 10))
	pairRequest.Header.Set("x-opencodex-gui-pair-origin", browserOrigin)
	pairRequest.Header.Set("x-opencodex-gui-pair-capability", capabilityToken)
	pairResponse, err := pairingClient.Do(pairRequest)
	if err != nil {
		return nil, "transport"
	}
	defer pairResponse.Body.Close()
	if pairResponse.StatusCode != http.StatusOK {
		return nil, "rejected"
	}
	pairRaw, readErr := io.ReadAll(io.LimitReader(pairResponse.Body, 64*1024))
	if readErr != nil {
		return nil, "rejected"
	}
	return parseGuiPairCreated(pairRaw, browserOrigin)
}

// healthzPairingIdentity mirrors the attestation checks: the /healthz identity
// must be our opencodex service (service marker or legacy trio) with matching
// pid and port before the proof header is trusted.
func healthzPairingIdentity(body *jsonwire.Value, state RuntimeState) bool {
	service := body.Find("service")
	if service != nil {
		if service.Kind() != jsonwire.String || service.String() != "opencodex" {
			return false
		}
	} else {
		status := body.Find("status")
		version := body.Find("version")
		uptime := body.Find("uptime")
		if status == nil || status.Kind() != jsonwire.String || status.String() != "ok" {
			return false
		}
		if version == nil || version.Kind() != jsonwire.String || uptime == nil || uptime.Kind() != jsonwire.Number {
			return false
		}
	}
	pid := body.Find("pid")
	if pid == nil || pid.Kind() != jsonwire.Number || pid.NumberRaw() != strconv.FormatInt(state.PID, 10) {
		return false
	}
	port := body.Find("port")
	return port != nil && port.Kind() == jsonwire.Number && port.NumberRaw() == strconv.Itoa(state.Port)
}

func createGuiPairCapability(secret, nonce, browserOrigin string, pid int64, port int, expiresAt int64) string {
	if !managementauth.IsAttestationSecret(secret) {
		return ""
	}
	if !guiGrantNoncePattern.MatchString(nonce) || !validPairingNumber(pid) || port <= 0 || port > 65535 || expiresAt <= 0 {
		return ""
	}
	if canonicalGuiBrowserOrigin(browserOrigin) != browserOrigin {
		return ""
	}
	payload := fmt.Sprintf("opencodex-gui-pair-v1\n%s\n%s\n%s\n%s\n%d\n%d\n%d", nonce, guiPairMethod, guiPairPath, browserOrigin, pid, port, expiresAt)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

var guiGrantNoncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func validPairingNumber(value int64) bool { return value > 0 }

// parseGuiPairCreated mirrors parseCreatedResult: the response body must be an
// object whose grant matches the secret shape, whose browserOrigin round-trips
// the canonical check, and whose expiresAt is a safe integer.
func parseGuiPairCreated(raw []byte, browserOrigin string) (*guiPairCreated, string) {
	body, err := jsonwire.Parse(raw)
	if err != nil || body.Kind() != jsonwire.Object {
		return nil, "rejected"
	}
	grant := body.Find("grant")
	if grant == nil || grant.Kind() != jsonwire.String || !guiGrantPattern.MatchString(grant.String()) {
		return nil, "rejected"
	}
	responseOrigin := body.Find("browserOrigin")
	if responseOrigin == nil || responseOrigin.Kind() != jsonwire.String || canonicalGuiBrowserOrigin(responseOrigin.String()) != browserOrigin {
		return nil, "rejected"
	}
	expiresAt := body.Find("expiresAt")
	if expiresAt == nil || expiresAt.Kind() != jsonwire.Number {
		return nil, "rejected"
	}
	expiresValue, ok := parseJSONNumber(expiresAt.NumberRaw())
	if !ok || !isSafeInteger(expiresValue) {
		return nil, "rejected"
	}
	serverOriginValue := body.Find("serverOrigin")
	if serverOriginValue == nil || serverOriginValue.Kind() != jsonwire.String {
		return nil, "rejected"
	}
	// TS canonicalises the response's serverOrigin before it is printed.
	serverOrigin := canonicalHttpOrigin(serverOriginValue.String())
	if serverOrigin == "" {
		return nil, "rejected"
	}
	return &guiPairCreated{
		grant:         grant.String(),
		browserOrigin: browserOrigin,
		serverOrigin:  serverOrigin,
		expiresAt:     int64(expiresValue),
	}, ""
}

func isSafeInteger(value float64) bool {
	return value == float64(int64(value))
}

// runGuiCommand ports runGuiCommand plus the dispatch's openDefaultGui wiring.
func runGuiCommand(args []string, deps Deps) int {
	if len(args) == 0 {
		return openGuiDashboard(deps)
	}
	if args[0] != "pair" {
		fmt.Fprintf(deps.Stderr, "Usage: %s\n", guiUsage)
		return ExitFailure
	}
	parsed := parseGuiPairArgs(args[1:])
	var canonical string
	if parsed != nil {
		canonical = canonicalGuiBrowserOrigin(parsed.origin)
	}
	if parsed == nil || canonical == "" || canonical != parsed.origin {
		fmt.Fprintf(deps.Stderr, "Usage: %s\n", guiUsage)
		return ExitFailure
	}
	cfg := readGuiConfig()
	if !allowedGuiPairingOrigin(canonical, cfg) {
		fmt.Fprintln(deps.Stderr, "The pairing origin is not enabled by hub.managementPublicOrigin or corsAllowOrigins.")
		return ExitFailure
	}
	// Discovery mirrors gui.ts's findLiveProxy (runtime record first, then the
	// configured port); the pairing client itself re-reads the runtime record
	// and rejects anything that is not the attested live process.
	state, found := liveProxyEndpoint(deps)
	if !found {
		fmt.Fprintln(deps.Stderr, "No running attested OpenCodex proxy is available for GUI pairing.")
		return ExitFailure
	}
	result, reason := requestGuiPairingGrant(state, canonical, deps)
	if result == nil {
		fmt.Fprintf(deps.Stderr, "GUI pairing failed (%s).\n", reason)
		return ExitFailure
	}
	if parsed.json {
		fmt.Fprintf(deps.Stdout, "{\"kind\":\"created\",\"grant\":%s,\"browserOrigin\":%s,\"serverOrigin\":%s,\"expiresAt\":%d,\"warning\":%s}\n",
			jsonString(result.grant), jsonString(result.browserOrigin), jsonString(result.serverOrigin), result.expiresAt, jsonString(guiPairingWarning))
	} else {
		fmt.Fprintln(deps.Stdout, result.grant)
		fmt.Fprintln(deps.Stderr, guiPairingWarning)
	}
	return ExitOK
}

func jsonString(value string) string {
	encoded, err := jsonwire.EncodeString(value)
	if err != nil {
		// encodeString cannot fail for a valid string; stay safe by quoting.
		return strconv.Quote(value)
	}
	return string(encoded)
}

// openGuiDashboard ports the dispatch openDefaultGui: find the attested live
// proxy (runtime record first, then the configured port), start one when absent,
// and open the bound host's dashboard URL in the OS browser.
func openGuiDashboard(deps Deps) int {
	cfg := readGuiConfig()
	state, found := liveProxyEndpoint(deps)
	if !found {
		fmt.Fprintln(deps.Stdout, "Proxy not running. Starting...")
		argv := []string{"start"}
		if cfg.port > 0 {
			argv = append(argv, "--port", strconv.Itoa(cfg.port))
		}
		if !spawnDetachedSelf(argv, deps) {
			fmt.Fprintln(deps.Stderr, "❌ Proxy did not become healthy after starting. Not opening the GUI.")
			return ExitFailure
		}
		deadline := time.Now().Add(40 * time.Second)
		for time.Now().Before(deadline) {
			if candidate, ok := liveProxyEndpoint(deps); ok {
				state = candidate
				found = true
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !found {
			fmt.Fprintln(deps.Stderr, "❌ Proxy did not become healthy after starting. Not opening the GUI.")
			return ExitFailure
		}
	}
	hostname := state.Hostname
	if hostname == "" {
		hostname = cfg.hostname
	}
	guiHost := probeHost(hostname)
	if guiHost == "127.0.0.1" {
		guiHost = "localhost"
	}
	port := state.Port
	if port == 0 {
		port = cfg.port
	}
	guiURL := fmt.Sprintf("http://%s:%d", guiHost, port)
	fmt.Fprintf(deps.Stdout, "Opening %s\n", guiURL)
	openBrowser(guiURL)
	return ExitOK
}

func isGoTestBinary(executable string) bool {
	base := strings.ToLower(filepath.Base(executable))
	return strings.HasSuffix(base, ".test") || strings.HasSuffix(base, ".test.exe")
}

// spawnDetachedSelf must not recurse into the Go test binary. os.Executable
// points at ocxcli.test under go test; launching it with start turns a
// short-lived test child into a long-lived proxy and leaves one high-CPU
// process behind for every launcher test that misses a live proxy.
func spawnDetachedSelf(argv []string, deps Deps) bool {
	deps = defaults(deps)
	executable, err := os.Executable()
	if err != nil {
		return false
	}
	if isGoTestBinary(executable) {
		return false
	}
	command := exec.Command(executable, argv...)
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Start(); err == nil {
		// Release the child so it outlives this process; its stdio is ignored.
		_ = command.Process.Release()
		return true
	}
	return false
}

// openBrowser mirrors openUrl: spawn the platform opener detached with stdio
// ignored; headless hosts report ENOENT asynchronously and must not crash us.
func openBrowser(rawURL string) {
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return
	}
	var name string
	var args []string
	switch runtimeOS() {
	case "darwin":
		name = "open"
		args = []string{rawURL}
	case "windows":
		systemRoot := os.Getenv("SystemRoot")
		if systemRoot == "" {
			systemRoot = os.Getenv("WINDIR")
		}
		if systemRoot == "" {
			systemRoot = "C:\\Windows"
		}
		name = systemRoot + "\\System32\\rundll32.exe"
		args = []string{"url.dll,FileProtocolHandler", rawURL}
	default:
		name = "xdg-open"
		args = []string{rawURL}
	}
	command := exec.Command(name, args...)
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Start(); err == nil {
		_ = command.Process.Release()
	}
}

func runtimeOS() string {
	return osRuntime
}
