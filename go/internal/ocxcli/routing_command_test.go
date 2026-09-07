package ocxcli

// Config-routing families (ocx alias/combo/route, issue #49) — Go unit tests
// mirroring the usage_command_test pattern. Argument validation runs before
// discovery (ReadRuntime errors "unused"), the no-proxy hint uses
// os.ErrNotExist, and live flows run against a canned httptest management
// plane keyed on the same routes the parity fixture pins.

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func routingRuntimeState(t *testing.T, server *httptest.Server) RuntimeState {
	t.Helper()
	port := atoi(t, server.URL[len("http://127.0.0.1:"):])
	return RuntimeState{PID: 1, Port: port, Hostname: "127.0.0.1", AttestationSecret: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}
}

func routingFixtureServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok","service":"opencodex","version":"test","uptime":1,"pid":1}`)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func routingDeps(t *testing.T, server *httptest.Server, stdout, stderr *bytes.Buffer) Deps {
	t.Helper()
	return Deps{
		Version:    "test",
		Stdout:     stdout,
		Stderr:     stderr,
		HTTPClient: server.Client(),
		ReadRuntime: func() (RuntimeState, error) {
			return routingRuntimeState(t, server), nil
		},
	}
}

func TestRoutingArgumentValidationExits2WithUsage(t *testing.T) {
	cases := []struct {
		name      string
		run       func(args []string, deps Deps) int
		args      []string
		message   string
		wantUsage bool
	}{
		{name: "alias set missing target", run: runAlias, args: []string{"set"}, message: "alias target is required", wantUsage: true},
		{name: "alias set trailing slash", run: runAlias, args: []string{"set", "alpha/"}, message: "target must be provider or provider/native-model-id", wantUsage: true},
		{name: "alias set leading slash", run: runAlias, args: []string{"set", "/m"}, message: "target must be provider or provider/native-model-id", wantUsage: true},
		{name: "alias set empty value", run: runAlias, args: []string{"set", "alpha"}, message: "alias value is required", wantUsage: true},
		{name: "alias set extra arg", run: runAlias, args: []string{"set", "alpha", "a", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "alias rm missing target", run: runAlias, args: []string{"rm"}, message: "alias target is required", wantUsage: true},
		{name: "alias defaults missing state", run: runAlias, args: []string{"defaults"}, message: "defaults requires on or off", wantUsage: true},
		{name: "alias defaults bad state", run: runAlias, args: []string{"defaults", "maybe"}, message: "defaults requires on or off", wantUsage: true},
		{name: "alias defaults empty provider", run: runAlias, args: []string{"defaults", "on", "--provider"}, message: "--provider requires a value", wantUsage: false},
		{name: "alias defaults extra arg", run: runAlias, args: []string{"defaults", "on", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "alias list extra arg", run: runAlias, args: []string{"list", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "alias unknown action", run: runAlias, args: []string{"frobnicate", "x"}, message: "unknown alias action 'frobnicate'", wantUsage: true},
		{name: "alias unknown action without target", run: runAlias, args: []string{"frobnicate"}, message: "alias target is required", wantUsage: true},
		{name: "combo unknown subcommand", run: runCombo, args: []string{"nope"}, message: "unknown combo command nope", wantUsage: true},
		{name: "combo show missing id", run: runCombo, args: []string{"show"}, message: "combo id is required", wantUsage: true},
		{name: "combo show extra arg", run: runCombo, args: []string{"show", "x", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "combo set missing id", run: runCombo, args: []string{"set"}, message: "combo id is required", wantUsage: true},
		{name: "combo set missing targets", run: runCombo, args: []string{"set", "x"}, message: "--targets is required", wantUsage: true},
		{name: "combo set empty targets", run: runCombo, args: []string{"set", "x", "--targets", ""}, message: "--targets is required", wantUsage: true},
		{name: "combo set dangling targets", run: runCombo, args: []string{"set", "x", "--targets"}, message: "--targets requires a value", wantUsage: false},
		{name: "combo set bad strategy", run: runCombo, args: []string{"set", "x", "--targets", "a/b", "--strategy", "bad"}, message: comboStrategiesError, wantUsage: true},
		{name: "combo set sticky without round-robin", run: runCombo, args: []string{"set", "x", "--targets", "a/b", "--sticky", "3"}, message: "--sticky applies only to round-robin", wantUsage: true},
		{name: "combo set sticky too large", run: runCombo, args: []string{"set", "x", "--targets", "a/b", "--strategy", "round-robin", "--sticky", "200"}, message: "--sticky must be <= 100", wantUsage: true},
		{name: "combo set sticky not integer", run: runCombo, args: []string{"set", "x", "--targets", "a/b", "--sticky", "abc"}, message: "--sticky must be an integer >= 1", wantUsage: false},
		{name: "combo set plain target", run: runCombo, args: []string{"set", "x", "--targets", "plain"}, message: "invalid target \"plain\"; use provider/model[:weight]", wantUsage: true},
		{name: "combo set trailing slash target", run: runCombo, args: []string{"set", "x", "--targets", "a/"}, message: "invalid target \"a/\"; use provider/model[:weight]", wantUsage: true},
		{name: "combo set zero weight", run: runCombo, args: []string{"set", "x", "--targets", "a/b:0"}, message: "target weight must be 1-10000: a/b:0", wantUsage: true},
		{name: "combo set extra arg", run: runCombo, args: []string{"set", "x", "--targets", "a/b", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "combo remove missing id", run: runCombo, args: []string{"remove"}, message: "combo id is required", wantUsage: true},
		{name: "combo remove without yes", run: runCombo, args: []string{"remove", "x"}, message: "remove requires --yes", wantUsage: true},
		{name: "route policy missing subcommand", run: runRoutePolicy, args: []string{}, message: "route policy requires a subcommand (list, show, dry-run, evaluate)", wantUsage: true},
		{name: "route policy unknown subcommand", run: runRoutePolicy, args: []string{"nope"}, message: "unknown route policy command: nope", wantUsage: true},
		{name: "route policy show needs id", run: runRoutePolicy, args: []string{"show", "--json"}, message: "profile id is required", wantUsage: true},
		{name: "route policy dry-run needs id", run: runRoutePolicy, args: []string{"evaluate", "--json"}, message: "profile id is required", wantUsage: true},
		{name: "route policy dry-run bad context", run: runRoutePolicy, args: []string{"dry-run", "x", "--model-context", "abc"}, message: "--model-context must be an integer >= 1", wantUsage: false},
		{name: "route policy dry-run dangling context", run: runRoutePolicy, args: []string{"dry-run", "x", "--model-context"}, message: "--model-context requires a value", wantUsage: false},
		{name: "route policy dry-run extra arg", run: runRoutePolicy, args: []string{"dry-run", "x", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "route policy show extra arg", run: runRoutePolicy, args: []string{"show", "x", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
		{name: "route policy list extra arg", run: runRoutePolicy, args: []string{"list", "extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, errors.New("unused") }}
			code := testCase.run(testCase.args, deps)
			if code != routingExitUsage {
				t.Fatalf("args %v exit = %d, want %d (stderr: %s)", testCase.args, code, routingExitUsage, stderr.String())
			}
			if !strings.Contains(stderr.String(), "Error: "+testCase.message) {
				t.Fatalf("args %v stderr missing %q:\n%s", testCase.args, "Error: "+testCase.message, stderr.String())
			}
			hasUsage := strings.Contains(stderr.String(), "ocx alias list [--json]") ||
				strings.Contains(stderr.String(), "ocx combo [list] [--json]") ||
				strings.Contains(stderr.String(), "ocx route policy list [--json]")
			if testCase.wantUsage && !hasUsage {
				t.Fatalf("args %v stderr missing USAGE block:\n%s", testCase.args, stderr.String())
			}
			if !testCase.wantUsage && strings.Contains(stderr.String(), "Usage:\n") {
				t.Fatalf("args %v stderr must not carry the USAGE block:\n%s", testCase.args, stderr.String())
			}
			if stdout.Len() != 0 {
				t.Fatalf("args %v stdout must stay empty:\n%s", testCase.args, stdout.String())
			}
		})
	}
}

func TestRoutingGateExits2OnUnknownFamily(t *testing.T) {
	for _, args := range [][]string{{}, {"comboize"}, {"nope"}} {
		var stdout, stderr bytes.Buffer
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, errors.New("unused") }}
		if code := runRoute(args, deps); code != routingExitUsage {
			t.Fatalf("route %v exit = %d, want 2", args, code)
		}
		if !strings.Contains(stderr.String(), "Usage: ocx route <combo|policy> <subcommand>") {
			t.Fatalf("route %v stderr missing gate line:\n%s", args, stderr.String())
		}
	}
}

func TestRoutingWithoutRuntimeReportsStartHint(t *testing.T) {
	// Isolate from any developer proxy: discovery falls back to the configured
	// port when no runtime record answers, so make the config fallback abort by
	// pointing OPENCODEX_HOME at an invalid config.json (Load errors instead of
	// probing a possibly-live 10100).
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	noRuntime := func() Deps {
		return Deps{Version: "test", Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, os.ErrNotExist }}
	}
	aliasCases := [][]string{{"list"}, {"defaults", "on"}, {"set", "alpha", "x"}, {"rm", "alpha"}}
	for _, args := range aliasCases {
		var stdout, stderr bytes.Buffer
		deps := noRuntime()
		deps.Stdout, deps.Stderr = &stdout, &stderr
		if code := runAlias(args, deps); code != 1 {
			t.Fatalf("alias %v exit = %d, want 1", args, code)
		}
		if !strings.Contains(stderr.String(), "Error: Proxy is not running. Start it with: ocx start") {
			t.Fatalf("alias %v unexpected stderr: %s", args, stderr.String())
		}
	}
	comboCases := [][]string{{"show", "fast"}, {"set", "fast", "--targets", "alpha/m1"}, {"remove", "fast", "--yes"}, {"list", "--json"}}
	for _, args := range comboCases {
		var stdout, stderr bytes.Buffer
		deps := noRuntime()
		deps.Stdout, deps.Stderr = &stdout, &stderr
		if code := runCombo(args, deps); code != 1 {
			t.Fatalf("combo %v exit = %d, want 1", args, code)
		}
		if !strings.Contains(stderr.String(), "Error: Proxy is not running. Start it with: ocx start") {
			t.Fatalf("combo %v unexpected stderr: %s", args, stderr.String())
		}
	}
	policyCases := [][]string{{"list"}, {"show", "p1"}, {"dry-run", "p1"}, {"evaluate", "p1", "--model-context", "9000", "--json"}}
	for _, args := range policyCases {
		var stdout, stderr bytes.Buffer
		deps := noRuntime()
		deps.Stdout, deps.Stderr = &stdout, &stderr
		if code := runRoutePolicy(args, deps); code != 1 {
			t.Fatalf("route policy %v exit = %d, want 1", args, code)
		}
		if !strings.Contains(stderr.String(), "Error: Proxy is not running. Start it with: ocx start") {
			t.Fatalf("route policy %v unexpected stderr: %s", args, stderr.String())
		}
	}
	// `ocx route combo list` shares the combo discovery path.
	var stdout, stderr bytes.Buffer
	deps := noRuntime()
	deps.Stdout, deps.Stderr = &stdout, &stderr
	if code := runCombo([]string{"list"}, deps); code != 1 {
		t.Fatalf("route combo list exit = %d, want 1", code)
	}
}

func routingManagementPlane(t *testing.T) *httptest.Server {
	t.Helper()
	return routingFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/aliases":
			fmt.Fprint(w, `{"providers":{"alpha":"a","beta":"b"},"models":{"alpha":{"m1":{"alias":"one","source":"user"}}},"defaults":{"global":true,"providers":{"alpha":false}}}`)
		case "GET /api/combos":
			fmt.Fprint(w, `{"combos":[{"id":"fast","model":"combo/fast","strategy":"failover","stickyLimit":1,"targets":[{"provider":"alpha","model":"m1","weight":2},{"provider":"beta","model":"b1"}]},{"id":"smart","model":"combo/smart","strategy":"round-robin","stickyLimit":3,"targets":[{"provider":"alpha","model":"m2"}],"alias":"smartie"}]}`)
		case "GET /api/routing-profiles":
			fmt.Fprint(w, `{"profiles":[{"id":"p1","model":"policy/p1","revision":3,"strategy":"cost"},{"id":"p2","revision":1}]}`)
		case "POST /api/routing-profiles/dry-run":
			fmt.Fprint(w, `{"profile":"p1","matched":true,"model":"policy/p1","reasons":["compatibility matched"],"evidence":{},"candidates":[]}`)
		case "PUT /api/default-aliases":
			fmt.Fprint(w, `{"ok":true,"catalogRefresh":{"status":"noop","ok":true}}`)
		case "PUT /api/combos":
			fmt.Fprint(w, `{"ok":true,"id":"fast"}`)
		case "DELETE /api/combos":
			if r.URL.Query().Get("id") == "gone" {
				w.WriteHeader(http.StatusNotFound)
				fmt.Fprint(w, `{"error":"unknown combo: gone"}`)
				return
			}
			fmt.Fprint(w, `{"ok":true,"id":"fast"}`)
		case "PUT /api/providers/beta/alias":
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"error":"alias conflicts with 'beta'"}`)
		case "PUT /api/providers/ghost/alias":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"error":"provider 'ghost' not found"}`)
		case "PUT /api/providers/alpha/alias":
			fmt.Fprint(w, `{"ok":true,"provider":"alpha","alias":"x","catalogRefresh":{"status":"noop","ok":true}}`)
		case "PUT /api/providers/alpha/model-aliases":
			fmt.Fprint(w, `{"ok":true,"aliases":{"m1":"one"},"catalogRefresh":{"status":"noop","ok":true}}`)
		default:
			http.NotFound(w, r)
		}
	})
}

func TestRoutingReadsAgainstFixture(t *testing.T) {
	server := routingManagementPlane(t)

	var stdout, stderr bytes.Buffer
	if code := runAlias([]string{"list"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias list exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"provider  alpha  a  user", "provider  beta  b  user", "model     alpha/m1  one  user"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("alias list stdout missing %q:\n%s", want, stdout.String())
		}
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"list", "--json"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias list --json exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"\"providers\": {", "\"alpha\": \"a\"", "\"models\": {"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("alias list --json stdout missing %q:\n%s", want, stdout.String())
		}
	}

	stdout.Reset()
	stderr.Reset()
	if code := runCombo([]string{"list"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("combo list exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"fast  combo/fast", "smart  combo/smart"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("combo list stdout missing %q:\n%s", want, stdout.String())
		}
	}

	stdout.Reset()
	stderr.Reset()
	if code := runCombo([]string{"show", "smart"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("combo show exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"\"id\": \"smart\"", "\"alias\": \"smartie\"", "\"stickyLimit\": 3"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("combo show stdout missing %q:\n%s", want, stdout.String())
		}
	}
	stdout.Reset()
	stderr.Reset()
	if code := runCombo([]string{"show", "missing"}, routingDeps(t, server, &stdout, &stderr)); code != routingExitUsage {
		t.Fatalf("combo show missing exit = %d, want 2 (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Error: unknown combo missing") {
		t.Fatalf("combo show missing stderr missing error:\n%s", stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	if code := runRoutePolicy([]string{"list"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("route policy list exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"p1  policy/p1  rev:3", "p2  policy/p2  rev:1"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("route policy list stdout missing %q:\n%s", want, stdout.String())
		}
	}

	stdout.Reset()
	stderr.Reset()
	if code := runRoutePolicy([]string{"show", "p2"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("route policy show exit = %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "\"id\": \"p2\"") || strings.Contains(stdout.String(), "\"model\"") {
		t.Fatalf("route policy show p2 must echo the model-less row raw:\n%s", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runRoutePolicy([]string{"dry-run", "p1", "--json"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("route policy dry-run exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"\"profile\": \"p1\"", "\"matched\": true", "\"compatibility matched\""} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("route policy dry-run stdout missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestRoutingWritesAgainstFixture(t *testing.T) {
	server := routingManagementPlane(t)

	var stdout, stderr bytes.Buffer
	if code := runAlias([]string{"defaults", "on"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias defaults on exit = %d (stderr: %s)", code, stderr.String())
	}
	if stdout.String() != "Default aliases on globally.\n" {
		t.Fatalf("alias defaults on stdout = %q", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"defaults", "off", "--provider", "alpha", "--json"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias defaults off --json exit = %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "\"catalogRefresh\": {") {
		t.Fatalf("alias defaults off --json stdout missing PUT echo:\n%s", stdout.String())
	}

	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"set", "alpha", "fast-a"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias set exit = %d (stderr: %s)", code, stderr.String())
	}
	if stdout.String() != "alpha → fast-a\n" {
		t.Fatalf("alias set stdout = %q", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"set", "alpha/m1", "one-a", "--json"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias set model-aliases exit = %d (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "\"aliases\": {") {
		t.Fatalf("alias set model-aliases --json stdout missing PUT echo:\n%s", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"rm", "alpha", "--json"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("alias rm exit = %d (stderr: %s)", code, stderr.String())
	}
	for _, want := range []string{"\"provider\": \"alpha\"", "\"catalogRefresh\": {"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("alias rm --json stdout missing %q:\n%s", want, stdout.String())
		}
	}

	// combo set performs the GET-before-PUT round trip; the human line matches.
	stdout.Reset()
	stderr.Reset()
	if code := runCombo([]string{"set", "fast", "--targets", "alpha/m1:2,beta/b1"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("combo set exit = %d (stderr: %s)", code, stderr.String())
	}
	if stdout.String() != "Saved combo fast.\n" {
		t.Fatalf("combo set stdout = %q", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runCombo([]string{"remove", "fast", "--yes"}, routingDeps(t, server, &stdout, &stderr)); code != 0 {
		t.Fatalf("combo remove exit = %d (stderr: %s)", code, stderr.String())
	}
	if stdout.String() != "Removed combo fast.\n" {
		t.Fatalf("combo remove stdout = %q", stdout.String())
	}

	// Write refusals select exit 5 (409) and 4 (404) with the body error.
	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"set", "beta", "b2"}, routingDeps(t, server, &stdout, &stderr)); code != routingExitConflict {
		t.Fatalf("alias set beta exit = %d, want 5 (stderr: %s)", code, stderr.String())
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "Error: alias conflicts with 'beta'") {
		t.Fatalf("alias set beta stdout/stderr = %q / %q", stdout.String(), stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAlias([]string{"set", "ghost", "g"}, routingDeps(t, server, &stdout, &stderr)); code != routingExitMissing {
		t.Fatalf("alias set ghost exit = %d, want 4 (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Error: provider 'ghost' not found") {
		t.Fatalf("alias set ghost stderr = %q", stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runCombo([]string{"remove", "gone", "--yes"}, routingDeps(t, server, &stdout, &stderr)); code != routingExitMissing {
		t.Fatalf("combo remove gone exit = %d, want 4 (stderr: %s)", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Error: unknown combo: gone") {
		t.Fatalf("combo remove gone stderr = %q", stderr.String())
	}
}
