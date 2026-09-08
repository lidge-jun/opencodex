package ocxcli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

// keyReloadTestServer starts a proxy-shaped httptest server: /healthz answers
// the attestation round with a providerReloadCapability body, and
// /api/providers/reload answers with reloadStatus. Returns the server plus a
// RuntimeState that ReadRuntime returns (already pointing at the server).
func keyReloadTestServer(t *testing.T, reloadStatus int) (*httptest.Server, RuntimeState, *string) {
	t.Helper()
	state := RuntimeState{PID: 9001, Hostname: "127.0.0.1", AttestationSecret: testSecret}
	var lastReloadPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			w.Header().Set(attestationProofHeader, managementauth.CreateLocalAttestationProof(
				testSecret, r.Header.Get(attestationChallengeHeader), state.PID, state.Port))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "service": "opencodex", "version": "2.42.0",
				"uptime": 1, "pid": state.PID, "port": state.Port,
				"providerReloadCapability": providerReloadCapabilityVersion,
			})
		case managementauth.LocalProviderReloadPath:
			lastReloadPath = r.URL.Path
			w.WriteHeader(reloadStatus)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	state.Port = serverPort(strings.TrimPrefix(server.URL, "http://"))
	return server, state, &lastReloadPath
}

func keyReloadDeps(t *testing.T, state RuntimeState) (Deps, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	var out, stderr bytes.Buffer
	deps := depsFor(state, &out, &stderr)
	deps.Challenge = func() (string, error) { return "QAZWSXEDCRFVTGBYHNUJMIKOLPqazwsxedcrfvtgbay", nil }
	return deps, &out, &stderr
}

func TestKeyReloadNotifiesAttestedProxy(t *testing.T) {
	_, state, lastPath := keyReloadTestServer(t, http.StatusOK)
	deps, _, stderr := keyReloadDeps(t, state)
	result := keyNotifyRunningProxy(deps, "zai")
	if result == nil || !result.ok {
		t.Fatalf("keyNotifyRunningProxy = %+v; want reloaded", result)
	}
	if *lastPath != "/api/providers/reload" {
		t.Fatalf("reload path = %q; want /api/providers/reload", *lastPath)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q; want empty on reloaded", stderr.String())
	}
}

func TestKeyReloadRejectedWarns(t *testing.T) {
	_, state, _ := keyReloadTestServer(t, http.StatusBadGateway)
	deps, _, stderr := keyReloadDeps(t, state)
	result := keyNotifyRunningProxy(deps, "zai")
	if result == nil || result.ok || result.reason != "rejected" {
		t.Fatalf("keyNotifyRunningProxy = %+v; want unavailable rejected", result)
	}
	// runLogin prints the warning after the success line; exercise the warn
	// helper directly to pin the exact bytes.
	keyWarnIfReloadSkipped(deps, result)
	want := "\n⚠️  A proxy is running but could not reload this provider (rejected)." +
		"\n   The credential is saved to disk; the running proxy keeps using the previous one." +
		"\n   Restart it to pick this up: ocx restart\n"
	if stderr.String() != want {
		t.Fatalf("stderr = %q; want %q", stderr.String(), want)
	}
}

func TestKeyReloadUnattestedTargetWarns(t *testing.T) {
	// A config-fallback discovery (no pid/secret) cannot carry the capability.
	deps, _, stderr := keyReloadDeps(t, RuntimeState{})
	deps.ReadRuntime = func() (RuntimeState, error) {
		return RuntimeState{}, nil
	}
	// No runtime record and no configured port: liveProxyEndpoint finds nothing,
	// so notify is a silent no-op (the TypeScript notifyRunningProxy null path).
	if result := keyNotifyRunningProxy(deps, "zai"); result != nil {
		t.Fatalf("keyNotifyRunningProxy with no proxy = %+v; want nil", result)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q; want empty (no proxy => nothing to notify)", stderr.String())
	}
}

func TestKeyReloadInvalidName(t *testing.T) {
	_, state, _ := keyReloadTestServer(t, http.StatusOK)
	deps, _, _ := keyReloadDeps(t, state)
	// A name outside the key table is not a live-reload provider: nil outcome.
	if result := keyNotifyRunningProxy(deps, "not-a-provider"); result != nil {
		t.Fatalf("keyNotifyRunningProxy(unknown) = %+v; want nil", result)
	}
	// A syntactically invalid reload name through the bound client is refused
	// with invalid-name before any network round.
	ok, reason := keyRequestBoundProviderReload(state, strings.Repeat("x", 300), deps)
	if ok || reason != "invalid-name" {
		t.Fatalf("keyRequestBoundProviderReload(long name) = %v %q; want invalid-name", ok, reason)
	}
}
