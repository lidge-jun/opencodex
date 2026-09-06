package ocxcli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

const testSecret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"

func testServer(t *testing.T, readyStatus string, validProof bool) (*httptest.Server, RuntimeState) {
	t.Helper()
	state := RuntimeState{PID: 4242, AttestationSecret: testSecret}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			proof := managementauth.CreateLocalAttestationProof(testSecret, r.Header.Get(attestationChallengeHeader), state.PID, state.Port)
			if !validProof {
				proof = strings.Repeat("x", 43)
			}
			w.Header().Set(attestationProofHeader, proof)
			json.NewEncoder(w).Encode(Health{Status: "ok", Service: "opencodex", Version: "2.42.0", Uptime: 1, PID: state.PID, Port: state.Port})
		case "/readyz":
			if readyStatus == "ready" {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
			json.NewEncoder(w).Encode(readiness{Service: "opencodex", Version: "2.42.0", Uptime: 1, PID: state.PID, Port: state.Port, Status: readyStatus})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	state.Port = serverPort(strings.TrimPrefix(server.URL, "http://"))
	return server, state
}

func serverPort(host string) int {
	_, raw, _ := net.SplitHostPort(host)
	var port int
	_, _ = fmt.Sscanf(raw, "%d", &port)
	return port
}

func depsFor(state RuntimeState, stdout, stderr *bytes.Buffer) Deps {
	return Deps{Version: "2.42.0", Stdout: stdout, Stderr: stderr, ReadRuntime: func() (RuntimeState, error) { return state, nil }}
}

func TestVersionAndRegistry(t *testing.T) {
	var out, err bytes.Buffer
	if got := Run([]string{"--version"}, depsFor(RuntimeState{}, &out, &err)); got != ExitOK || out.String() != "opencodex 2.42.0\n" {
		t.Fatalf("version = code %d stdout %q", got, out.String())
	}
	if len(Commands) != 8 || Commands[0].Name != "health" || Commands[1].Name != "ready" || Commands[2].Name != "status" || Commands[3].Name != "doctor" || Commands[4].Name != "service" || Commands[5].Name != "config" || Commands[6].Name != "models" || Commands[7].Name != "provider" {
		t.Fatalf("unexpected command registry: %#v", Commands)
	}
}

func TestStatusUsesAttestedRuntimeAndRejectsInvalidArgs(t *testing.T) {
	server, state := testServer(t, "ready", true)
	defer server.Close()
	var out, stderr bytes.Buffer
	if got := Run([]string{"status", "--json"}, depsFor(state, &out, &stderr)); got != ExitOK {
		t.Fatalf("status exit = %d stderr %q", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"running\":true") || !strings.Contains(out.String(), "\"source\":\"runtime\"") {
		t.Fatalf("status output = %q", out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"status", "--bad"}, depsFor(state, &out, &stderr)); got != ExitFailure || stderr.String() != "Usage: ocx status [--json]\n" {
		t.Fatalf("invalid status = code %d stderr %q", got, stderr.String())
	}
}

func TestDoctorAndServiceValidateReadOnlyArguments(t *testing.T) {
	var out, stderr bytes.Buffer
	if got := Run([]string{"doctor", "--json"}, depsFor(RuntimeState{}, &out, &stderr)); got != ExitFailure || stderr.String() != "Usage: ocx doctor\n" {
		t.Fatalf("invalid doctor = code %d stderr %q", got, stderr.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"service", "restart"}, depsFor(RuntimeState{}, &out, &stderr)); got != ExitFailure || stderr.String() != "Usage: ocx service status\n" {
		t.Fatalf("invalid service = code %d stderr %q", got, stderr.String())
	}
}

func TestReadOnlyFamilyHelp(t *testing.T) {
	for _, command := range []string{"status", "doctor", "service"} {
		t.Run(command, func(t *testing.T) {
			var out, stderr bytes.Buffer
			if got := Run([]string{"help", command}, depsFor(RuntimeState{}, &out, &stderr)); got != ExitOK {
				t.Fatalf("help exit = %d stderr %q", got, stderr.String())
			}
			if !strings.Contains(out.String(), "Usage: ocx "+command) {
				t.Fatalf("help output = %q", out.String())
			}
		})
	}
}

func TestHealthRequiresValidAttestationProof(t *testing.T) {
	server, state := testServer(t, "ready", true)
	defer server.Close()
	var out, stderr bytes.Buffer
	if got := Run([]string{"health", "--json"}, depsFor(state, &out, &stderr)); got != ExitOK {
		t.Fatalf("health exit = %d stderr %s", got, stderr.String())
	}
	if !strings.Contains(out.String(), "\"ok\":true") {
		t.Fatalf("health output %q", out.String())
	}
	server.Close()
	server, state = testServer(t, "ready", false)
	defer server.Close()
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"health"}, depsFor(state, &out, &stderr)); got != ExitFailure {
		t.Fatalf("bad proof exit = %d", got)
	}
}

func TestReadyAndUsageExitCodes(t *testing.T) {
	server, state := testServer(t, "ready", true)
	defer server.Close()
	var out, stderr bytes.Buffer
	if got := Run([]string{"ready", "--json"}, depsFor(state, &out, &stderr)); got != ExitOK || !strings.Contains(out.String(), "\"ready\":true") {
		t.Fatalf("ready = %d %q", got, out.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"ready", "--timeout", "5"}, depsFor(state, &out, &stderr)); got != ExitUsage {
		t.Fatalf("invalid ready = %d", got)
	}
}
