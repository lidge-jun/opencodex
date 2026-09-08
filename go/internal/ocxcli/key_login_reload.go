package ocxcli

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

// key_login_reload.go ports notifyRunningProxy + requestBoundLocalProviderReload
// (src/oauth/login-cli.ts + src/server/local-provider-reload-client.ts) for the
// key-login slice. After the provider row is persisted the Go binary asks the
// attested runtime proxy to reload that exact on-disk entry: a bodyless POST
// /api/providers/reload whose one-shot capability binds the provider name to
// the attested process, method, path, PID, port, and expiry. No provider
// object, API key, or reusable credential crosses the socket. A login with no
// running (attested-runtime) proxy is a silent no-op; a live proxy that cannot
// adopt the credential produces the TypeScript warning.

const providerReloadCapabilityVersion = "v1"

const keyReloadWarnSkipped = "\n⚠️  A proxy is running but could not reload this provider (%s)." +
	"\n   The credential is saved to disk; the running proxy keeps using the previous one." +
	"\n   Restart it to pick this up: ocx restart"

// keyReloadResult mirrors LocalProviderReloadResult: ok == true means reloaded;
// ok == false carries the unavailable reason.
type keyReloadResult struct {
	ok     bool
	reason string
}

// keyNotifyRunningProxy mirrors notifyRunningProxy: it returns nil when there
// is nothing to notify (no live proxy), otherwise the reload outcome.
func keyNotifyRunningProxy(deps Deps, name string) *keyReloadResult {
	deps = defaults(deps)
	// The provider name must be a live-reload provider; every Go key-login name
	// is, so this only guards against a drifted table.
	if _, ok := keyLoginProviders[name]; !ok {
		return nil
	}
	state, found := liveProxyEndpoint(deps)
	if !found {
		return nil
	}
	ok, reason := keyRequestBoundProviderReload(state, name, deps)
	return &keyReloadResult{ok: ok, reason: reason}
}

// keyRequestBoundProviderReload mirrors requestBoundLocalProviderReload: ask the
// exact runtime proxy to reload one already-persisted provider.
func keyRequestBoundProviderReload(state RuntimeState, name string, deps Deps) (bool, string) {
	deps = defaults(deps)
	if !managementauth.IsLocalProviderReloadName(name) {
		return false, "invalid-name"
	}
	// A discovered proxy that is not the attested runtime process (config-
	// fallback or pid-less discovery) cannot carry the reload capability.
	if state.PID <= 0 || state.Port < 1 || state.Port > 65535 || !managementauth.IsAttestationSecret(state.AttestationSecret) {
		return false, "unattested-target"
	}
	reRead, readErr := deps.ReadRuntime()
	if readErr != nil || !sameReloadRuntime(state, reRead) {
		return false, "runtime-mismatch"
	}
	challenge, err := deps.Challenge()
	if err != nil {
		return false, "transport"
	}
	client := deps.HTTPClient
	request, err := http.NewRequest(http.MethodGet, baseURL(state)+"/healthz", nil)
	if err != nil {
		return false, "transport"
	}
	request.Header.Set(attestationChallengeHeader, challenge)
	response, err := client.Do(request)
	if err != nil {
		return false, "transport"
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if readErr != nil || response.StatusCode != http.StatusOK {
		return false, "attestation"
	}
	body, parseErr := jsonwire.Parse(raw)
	if parseErr != nil || body.Kind() != jsonwire.Object {
		return false, "attestation"
	}
	if !healthzReloadIdentity(body, state) {
		return false, "attestation"
	}
	proof := response.Header.Get(attestationProofHeader)
	if !managementauth.VerifyLocalAttestationProof(state.AttestationSecret, challenge, state.PID, state.Port, proof) {
		return false, "attestation"
	}
	if capability := body.Find("providerReloadCapability"); capability == nil || capability.Kind() != jsonwire.String || capability.String() != providerReloadCapabilityVersion {
		return false, "attestation"
	}
	// The proxy could have restarted between discovery and the proof round;
	// re-check that the runtime record is still the one we attested.
	reRead, readErr = deps.ReadRuntime()
	if readErr != nil || !sameReloadRuntime(state, reRead) {
		return false, "runtime-mismatch"
	}
	expiresAt := time.Now().UnixMilli() + int64(managementauth.LocalProviderReloadCapabilityTTLMs)
	capabilityToken := managementauth.CreateLocalProviderReloadCapability(
		state.AttestationSecret, challenge, managementauth.LocalProviderReloadMethod,
		managementauth.LocalProviderReloadPath, name, state.PID, state.Port, expiresAt)
	if capabilityToken == "" {
		return false, "capability"
	}
	reloadRequest, err := http.NewRequest(managementauth.LocalProviderReloadMethod, baseURL(state)+managementauth.LocalProviderReloadPath, nil)
	if err != nil {
		return false, "transport"
	}
	reloadRequest.Header.Set("Content-Length", "0")
	reloadRequest.Header.Set(managementauth.LocalProviderReloadExpectedPIDHeader, strconv.FormatInt(state.PID, 10))
	reloadRequest.Header.Set(managementauth.LocalProviderReloadNonceHeader, challenge)
	reloadRequest.Header.Set(managementauth.LocalProviderReloadExpiresAtHeader, strconv.FormatInt(expiresAt, 10))
	reloadRequest.Header.Set(managementauth.LocalProviderReloadNameHeader, name)
	reloadRequest.Header.Set(managementauth.LocalProviderReloadCapabilityHeader, capabilityToken)
	reloadResponse, err := client.Do(reloadRequest)
	if err != nil {
		return false, "transport"
	}
	defer reloadResponse.Body.Close()
	if reloadResponse.StatusCode != http.StatusOK {
		return false, "rejected"
	}
	return true, ""
}

// sameReloadRuntime mirrors the reload client's readRuntime comparison: pid,
// port, hostname, and the attestation secret must all still match the attested
// runtime record.
func sameReloadRuntime(state, reRead RuntimeState) bool {
	return reRead.PID == state.PID && reRead.Port == state.Port &&
		reRead.Hostname == state.Hostname && reRead.AttestationSecret == state.AttestationSecret
}

// healthzReloadIdentity mirrors the reload client's /healthz checks: the body
// must be our opencodex service (service marker or legacy trio) with matching
// pid and port before the proof header is trusted.
func healthzReloadIdentity(body *jsonwire.Value, state RuntimeState) bool {
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

// keyWarnIfReloadSkipped mirrors warnIfLiveReloadSkipped: a live proxy that
// could not adopt the credential gets the TypeScript warning on stderr; nil
// (nothing to notify) and a successful reload print nothing.
func keyWarnIfReloadSkipped(deps Deps, result *keyReloadResult) {
	if result == nil || result.ok {
		return
	}
	fmt.Fprintf(deps.Stderr, keyReloadWarnSkipped, result.reason)
	fmt.Fprintln(deps.Stderr)
}
