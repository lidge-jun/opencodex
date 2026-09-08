package ocxcli

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Go-owned management families (debug/access/api-key/system) talk to the
// proxy's management plane through the same fixture-shaped servers as the
// differential oracle in tests/go-cli-parity.test.ts, so these tests pin the
// exact wire requests, human renderings, and exit taxonomy in Go without
// spawning the TS CLI. Golden strings below were captured from the TS CLI run
// against the identical fixture payloads.

const mgmtFixtureToken = "ocx_admin_go-unittest-token-abcdefghijklmnopqrstuvwxyz0123"

const mgmtKeysEnvelope = `{
  "keys": [
    {"id": "key-1", "name": "default", "prefix": "ocx_data_ab12", "createdAt": "2026-08-01T00:00:00.000Z", "usage": {"requests7d": 1447, "totalRequests": 9033}},
    {"id": "key-2", "name": "deploy", "prefix": "ocx_data_cd34", "createdAt": "2026-08-02T00:00:00.000Z", "usage": {"ambiguous": true}},
    {"id": "key-3", "name": "unused", "prefix": "ocx_data_ef56", "createdAt": "2026-08-03T00:00:00.000Z", "usage": {"requests7d": 0, "totalRequests": 0, "lastUsedAt": "2026-09-01T10:00:00.000Z"}}
  ],
  "attributionSince": "2026-08-01T00:00:00.000Z",
  "authMatrix": {"admin": ["GET", "POST"]},
  "baseUrl": "http://127.0.0.1:1/v1",
  "endpoint": "http://127.0.0.1:1/v1/responses"
}`

const mgmtSettingsPayload = `{"codexAutoStart":false,"streamMode":"auto","codexDesktopAuthless":false,"managementPort":10100,"desired":{"enabled":true}}`

// mgmtFixtureServer serves the /healthz discovery probe (service/pid gate like
// usageFixtureServer) and routes every other request to the handler.
func mgmtFixtureServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, func() RuntimeState) {
	t.Helper()
	server := usageFixtureServer(t, handler)
	state := func() RuntimeState {
		port := atoi(t, strings.TrimPrefix(server.URL, "http://127.0.0.1:"))
		return RuntimeState{PID: 1, Port: port, Hostname: "127.0.0.1", AttestationSecret: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}
	}
	return server, state
}

func mgmtDeps(t *testing.T, server *httptest.Server, state func() RuntimeState, stdout, stderr *bytes.Buffer) Deps {
	t.Helper()
	t.Setenv("OPENCODEX_ADMIN_AUTH_TOKEN", mgmtFixtureToken)
	return Deps{Version: "test", Stdout: stdout, Stderr: stderr, ReadRuntime: func() (RuntimeState, error) { return state(), nil }, HTTPClient: server.Client()}
}

func readRequestBody(t *testing.T, r *http.Request) string {
	t.Helper()
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestAccessKeyListHumanMatchesTSGolden(t *testing.T) {
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/keys" || r.Method != http.MethodGet {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		fmt.Fprint(w, mgmtKeysEnvelope)
	})
	var stdout, stderr bytes.Buffer
	code := runAccess([]string{"key"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	want := "ID     NAME     PREFIX         REQ 7D     TOTAL  LAST USED\n" +
		"key-1  default  ocx_data_ab12  1,447      9,033  never\n" +
		"key-2  deploy   ocx_data_cd34  ambiguous\n" +
		"key-3  unused   ocx_data_ef56  0          0      2026-09-01T10:00:00.000Z\n" +
		"\n" +
		"attribution since 2026-08-01T00:00:00.000Z\n" +
		"ambiguous: two configured keys share an id, so per-key totals do not exist\n"
	if stdout.String() != want {
		t.Fatalf("key list stdout mismatch:\n--- want ---\n%s\n--- got ---\n%s", want, stdout.String())
	}
}

// TestSystemCodexCliUpdateCarveOutStaysTypeScriptOwned mirrors the models
// runtime-subcommand seam: system owns every verb except codex-cli-update,
// which is a read-only local Codex install inspection that must keep
// delegating to the TypeScript CLI (no management plane, no proxy).
func TestSystemCodexCliUpdateCarveOutStaysTypeScriptOwned(t *testing.T) {
	for _, args := range [][]string{
		{"system", "codex-cli-update"},
		{"system", "codex-cli-update", "check"},
		{"system", "codex-cli-update", "check", "--json"},
	} {
		if got, known := OwnershipFor(args); !known || got != TypeScriptOwned {
			t.Fatalf("OwnershipFor(%v) = %q, %t; want typescript-owned, true", args, got, known)
		}
	}
	for _, args := range [][]string{
		{"system", "settings"},
		{"system", "status", "--json"},
		{"system", "codex-restart", "--yes"},
		{"system", "update", "check"},
	} {
		if got, known := OwnershipFor(args); !known || got != GoOwned {
			t.Fatalf("OwnershipFor(%v) = %q, %t; want go-owned, true", args, got, known)
		}
	}
}

func TestApiKeyAliasRunsAccessKeyList(t *testing.T) {
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, mgmtKeysEnvelope)
	})
	var stdout, stderr bytes.Buffer
	code := runApiKey([]string{"list"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "ID     NAME     PREFIX") || !strings.Contains(stdout.String(), "attribution since") {
		t.Fatalf("api-key list did not delegate to access key rendering:\n%s", stdout.String())
	}
}

func TestAccessKeyCreateSendsNameAndReprintsEnvelope(t *testing.T) {
	var gotBody string
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		gotBody = readRequestBody(t, r)
		fmt.Fprint(w, `{"id":"key-new","name":"deploy","key":"ocx_data_newsecret","createdAt":"2026-09-05T00:00:00.000Z"}`)
	})
	var stdout, stderr bytes.Buffer
	code := runAccess([]string{"key", "create", "deploy"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	if gotBody != `{"name":"deploy"}` {
		t.Fatalf("create body = %s", gotBody)
	}
	want := "Created API key deploy (key-new).\nKey (shown once): ocx_data_newsecret\n"
	if stdout.String() != want {
		t.Fatalf("create stdout mismatch:\n--- want ---\n%s\n--- got ---\n%s", want, stdout.String())
	}
}

func TestAccessRotationBodyAndAbortMethod(t *testing.T) {
	var startBody, commitBody string
	var aborted bool
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/keys/rotate":
			if r.Method == http.MethodPost {
				startBody = readRequestBody(t, r)
				fmt.Fprint(w, `{"id":"key-1","rotationId":"rot-1","key":"ocx_data_rotsecret","createdAt":"2026-09-05T00:00:00.000Z"}`)
			} else if r.Method == http.MethodDelete {
				aborted = true
				commitBody = readRequestBody(t, r)
				fmt.Fprint(w, `{"ok":true}`)
			}
		case "/api/keys/rotate/commit":
			commitBody = readRequestBody(t, r)
			fmt.Fprint(w, `{"ok":true}`)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})
	var stdout, stderr bytes.Buffer
	deps := mgmtDeps(t, server, state, &stdout, &stderr)
	if code := runAccess([]string{"key", "rotate", "key-1"}, deps); code != ExitOK {
		t.Fatalf("rotate start exit = %d, stderr:\n%s", code, stderr.String())
	}
	if startBody != `{"id":"key-1"}` {
		t.Fatalf("rotate start body = %s", startBody)
	}
	stdout.Reset()
	if code := runAccess([]string{"key", "rotate", "commit", "key-1", "rot-1"}, deps); code != ExitOK {
		t.Fatalf("rotate commit exit = %d, stderr:\n%s", code, stderr.String())
	}
	if commitBody != `{"id":"key-1","rotationId":"rot-1"}` {
		t.Fatalf("rotate commit body = %s", commitBody)
	}
	stdout.Reset()
	if code := runAccess([]string{"key", "rotate", "abort", "key-1", "rot-1"}, deps); code != ExitOK {
		t.Fatalf("rotate abort exit = %d, stderr:\n%s", code, stderr.String())
	}
	if !aborted {
		t.Fatal("abort did not DELETE /api/keys/rotate")
	}
}

func TestDebugProviderStatusReadsEnvAndRuntimeOverride(t *testing.T) {
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"enabled":false,"usage":false,"injection":false,"claude":false,"runtimeOverride":{},"env":{"debug":true,"usage":false,"injection":false,"claude":false}}`)
	})
	var stdout, stderr bytes.Buffer
	code := runDebug([]string{"provider", "status"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	want := "Provider debug: off\n" +
		"  env=on, runtime=env/default\n" +
		"  Tail: ocx debug provider logs [-f]\n"
	if stdout.String() != want {
		t.Fatalf("status stdout mismatch:\n--- want ---\n%s\n--- got ---\n%s", want, stdout.String())
	}
}

func TestDebugProviderToggleAndResetWireBodies(t *testing.T) {
	var gotBody string
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotBody = readRequestBody(t, r)
		fmt.Fprint(w, `{"enabled":true,"usage":false,"injection":false,"claude":false,"runtimeOverride":{"debug":true},"env":{"debug":true,"usage":false,"injection":false,"claude":false}}`)
	})
	var stdout, stderr bytes.Buffer
	deps := mgmtDeps(t, server, state, &stdout, &stderr)
	if code := runDebug([]string{"provider", "on"}, deps); code != ExitOK {
		t.Fatalf("on exit = %d, stderr:\n%s", code, stderr.String())
	}
	if gotBody != `{"debug":true}` {
		t.Fatalf("toggle body = %s", gotBody)
	}
	want := "Provider debug: ON\n  env=on, runtime=on\n  Tail: ocx debug provider logs [-f]\n\nprovider debug is now enabled.\n"
	if stdout.String() != want {
		t.Fatalf("on stdout mismatch:\n--- want ---\n%s\n--- got ---\n%s", want, stdout.String())
	}
	stdout.Reset()
	if code := runDebug([]string{"provider", "reset"}, deps); code != ExitOK {
		t.Fatalf("reset exit = %d, stderr:\n%s", code, stderr.String())
	}
	if gotBody != `{"reset":"provider"}` {
		t.Fatalf("reset body = %s", gotBody)
	}
}

func TestSystemSettingsHumanMatchesTSGolden(t *testing.T) {
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s", r.Method)
		}
		fmt.Fprint(w, mgmtSettingsPayload)
	})
	var stdout, stderr bytes.Buffer
	code := runSystem([]string{"settings"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	want := "codexAutoStart: false\n" +
		"streamMode: auto\n" +
		"codexDesktopAuthless: false\n" +
		"managementPort: 10100\n" +
		"desired.enabled: true\n"
	if stdout.String() != want {
		t.Fatalf("settings stdout mismatch:\n--- want ---\n%s\n--- got ---\n%s", want, stdout.String())
	}
}

func TestSystemCodexAppServerDefaultsToJSONReprint(t *testing.T) {
	// No human summary lines exist for codex-app-server, so printData falls back
	// to console.log(JSON.stringify(body, null, 2)) even without --json.
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"reachable":true,"pid":4242}`)
	})
	var stdout, stderr bytes.Buffer
	code := runSystem([]string{"codex-app-server"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	want := "{\n  \"reachable\": true,\n  \"pid\": 4242\n}\n"
	if stdout.String() != want {
		t.Fatalf("codex-app-server stdout mismatch:\n--- want ---\n%s\n--- got ---\n%s", want, stdout.String())
	}
}

func TestManagementUsageFailuresExit2WithAccessUsage(t *testing.T) {
	cases := []struct {
		command string
		args    []string
		message string
	}{
		{command: "access", args: []string{"bogus"}, message: "unknown access command bogus"},
		{command: "access", args: []string{"key", "remove", "key-1"}, message: "remove requires --yes"},
		{command: "system", args: []string{"startup", "bogus"}, message: "startup action must be health, install-service, or install-shim"},
		{command: "system", args: []string{"update", "bogus"}, message: "unknown update action bogus"},
		{command: "system", args: []string{"codex-restart"}, message: "system codex-restart requires --yes"},
	}
	for _, testCase := range cases {
		var stdout, stderr bytes.Buffer
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, fmt.Errorf("unused") }}
		var code int
		switch testCase.command {
		case "access":
			code = runAccess(testCase.args, deps)
		case "system":
			code = runSystem(testCase.args, deps)
		}
		if code != mgmtExitUsage {
			t.Fatalf("%s %v exit = %d, want %d (stderr: %s)", testCase.command, testCase.args, code, mgmtExitUsage, stderr.String())
		}
		if !strings.Contains(stderr.String(), "Error: "+testCase.message) {
			t.Fatalf("%s %v stderr missing %q:\n%s", testCase.command, testCase.args, "Error: "+testCase.message, stderr.String())
		}
	}
}

func TestManagementUnknownSystemAndDebugScope(t *testing.T) {
	var stdout, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, fmt.Errorf("unused") }}
	if code := runSystem([]string{"bogus"}, deps); code != mgmtExitUsage {
		t.Fatalf("system bogus exit = %d, want %d", code, mgmtExitUsage)
	}
	if !strings.Contains(stderr.String(), "Error: unknown system command bogus") {
		t.Fatalf("system bogus stderr:\n%s", stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	// Debug with an unknown scope prints the family help on stdout and exits 1.
	if code := runDebug([]string{"bogus"}, deps); code != ExitFailure {
		t.Fatalf("debug bogus exit = %d, want 1", code)
	}
	if !strings.Contains(stdout.String(), "Debug commands (proxy must be running):") {
		t.Fatalf("debug bogus stdout:\n%s", stdout.String())
	}
}

func TestManagementAPIErrorComposesEnvelopeAndExitTaxonomy(t *testing.T) {
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"opencodex admin token required","reason":"no matching credential","hint":"Set OPENCODEX_ADMIN_AUTH_TOKEN to the token written to OPENCODEX_HOME/admin-api-token"}`)
	})
	var stdout, stderr bytes.Buffer
	code := runSystem([]string{"sync"}, mgmtDeps(t, server, state, &stdout, &stderr))
	if code != ExitFailure {
		t.Fatalf("401 exit = %d, want 1", code)
	}
	for _, want := range []string{"Error: opencodex admin token required", "reason: no matching credential", "hint: Set OPENCODEX_ADMIN_AUTH_TOKEN"} {
		if !strings.Contains(stderr.String(), want) {
			t.Fatalf("stderr missing %q:\n%s", want, stderr.String())
		}
	}

	// 404 maps to exit 4, 409 to exit 5, exactly like the TS RuntimeApiError
	// taxonomy used by the parity oracle's non-2xx rows.
	codes := map[int]int{http.StatusNotFound: mgmtExitMissing, http.StatusConflict: mgmtExitConflict, http.StatusBadGateway: ExitFailure}
	for status, wantCode := range codes {
		server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			fmt.Fprint(w, `{"error":"denied by fixture","reason":"taxonomy probe"}`)
		})
		var stdout, stderr bytes.Buffer
		code := runSystem([]string{"sync"}, mgmtDeps(t, server, state, &stdout, &stderr))
		if code != wantCode {
			t.Fatalf("status %d exit = %d, want %d (stderr: %s)", status, code, wantCode, stderr.String())
		}
	}
}

func TestManagementAdminTokenSentFromEnv(t *testing.T) {
	var gotToken string
	server, state := mgmtFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-OpenCodex-API-Key")
		fmt.Fprint(w, mgmtSettingsPayload)
	})
	var stdout, stderr bytes.Buffer
	if code := runSystem([]string{"settings"}, mgmtDeps(t, server, state, &stdout, &stderr)); code != ExitOK {
		t.Fatalf("exit = %d, stderr:\n%s", code, stderr.String())
	}
	if gotToken != mgmtFixtureToken {
		t.Fatalf("token header = %q, want %q", gotToken, mgmtFixtureToken)
	}
}
