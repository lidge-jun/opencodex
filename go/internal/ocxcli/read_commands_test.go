package ocxcli

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// The fixture payloads mirror the canned routes in tests/go-cli-parity.test.ts
// (issue #45), so the Go renderers are diffed against the same shapes the
// TypeScript oracle pins byte-for-byte.

const logsFixturePayload = `{"timeZone":"Asia/Shanghai","total":2,"logs":[{"requestId":"ocx-1111111111","timestamp":1788818801331,"provider":"fixture","model":"fixture-model","status":502,"durationMs":344,"conversationId":"conv-abc-123"},{"createdAt":"2026-08-22T10:00:00Z","provider":"xai","model":"grok-4.6","statusCode":200}]}`

const memoryFixturePayload = `{"pid":4242,"bunVersion":"1.3.14","platform":"linux","uptimeSeconds":123.456,"rss":104857600,"heapUsed":33554432,"observedMetric":"rss","jscHeap":{"heapSize":33554432,"objectCount":1024},"responseState":{"count":0},"appOwnedBytes":{"budgetBytes":268435456,"stores":{"a":{"b":1}},"observedInFlight":[1,2,3]},"streamMode":"auto","eagerRelay":null,"watchdog":{"warnThresholdBytes":4294967296,"samples":[1,2]},"isDraining":false,"freeHeapRatioHistory":[0.5,null,0.4]}`

const routeDecisionFixturePayload = `{"requestId":"req-1","routeDecision":{"version":1,"decisionId":"d1","candidates":[{"provider":"fixture","eligible":true}]},"attemptSequence":[]}`

const inspectConfigFixturePayload = `{"port":10100,"defaultProvider":"fixture","codexAutoStart":true,"providers":{"fixture":{"adapter":"openai-chat","hasApiKey":true}},"tiers":null}`

const inspectRoutingAnalyticsFixturePayload = `{"generatedAt":1788818834015,"totalRequests":1,"confidence":"low","successRate":0,"failureRate":1,"durationMs":{"p50":344,"sampleCount":1},"breakdown":[{"provider":"fixture","count":1}],"profileBreakdown":[],"priceCoverage":null,"estimatedCostUsdPerSuccessfulRequest":null}`

const inspectPacingFixturePayload = `{"fixture":{"provider":"fixture","enabled":false,"queued":0,"nextSlotInMs":0}}`

const inspectCodexPromptFixturePayload = `{"configPath":"/home/u/.codex/config.toml","configExists":true,"readable":true,"drift":null,"inventory":[{"id":"base-instructions","class":"base","order":0}],"layers":{"base":"text"}}`

const inspectClientConfigFixturePayload = `{"clientId":"codex","baseUrl":"http://127.0.0.1:10100","env":{"OPENAI_BASE_URL":"http://127.0.0.1:10100/v1"}}`

const inspectStarFixturePayload = `{"state":"not-starred","repo":"waxiangzi/opencodex","url":"https://github.com/waxiangzi/opencodex"}`

// inspectTextFixturePayload is a JSON string whose decoded body is the prompt
// text; the printed prompt then carries one trailing newline from the payload
// and one from console.log.
const inspectTextFixturePayload = `"You are Codex, the world's most advanced coding agent.\n"`

// readFixtureRoutes serves canned payloads for every route the three flipped
// commands read. Every case sets OPENCODEX_HOME to an empty scratch dir so the
// config-port fallback inside liveProxyEndpoint can never reach a real proxy.
var readFixtureRoutes = map[string]string{
	"/api/logs":          logsFixturePayload,
	"/api/system/memory": memoryFixturePayload,
	"/api/request-history/req-1/route-decision": routeDecisionFixturePayload,
	"/api/config":                  inspectConfigFixturePayload,
	"/api/routing-analytics":       inspectRoutingAnalyticsFixturePayload,
	"/api/provider-request-pacing": inspectPacingFixturePayload,
	"/api/codex-prompt":            inspectCodexPromptFixturePayload,
	"/api/codex-prompt/text":       inspectTextFixturePayload,
	"/api/client-config":           inspectClientConfigFixturePayload,
	"/api/github/star":             inspectStarFixturePayload,
}

// readFixtureServer serves an attested /healthz identity probe (the
// findLiveProxy gate) plus canned routes.
func readFixtureServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok","service":"opencodex","version":"test","uptime":1,"pid":4242}`)
			return
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func readDeps(t *testing.T, server *httptest.Server) (Deps, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	port := server.URL[len("http://127.0.0.1:"):]
	runtimeState := RuntimeState{PID: 4242, Port: atoi(t, port), Hostname: "127.0.0.1", AttestationSecret: testSecret}
	var stdout, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return runtimeState, nil }, HTTPClient: server.Client()}
	return deps, &stdout, &stderr
}

func runReadWithFixture(t *testing.T, argv []string) (int, string, string) {
	t.Helper()
	server := readFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		payload, ok := readFixtureRoutes[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, payload)
	})
	deps, stdout, stderr := readDeps(t, server)
	return Run(argv, deps), stdout.String(), stderr.String()
}

func TestMemoryOutputMatchesTypeScriptFixture(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"memory"})
	if code != 0 || stderr != "" {
		t.Fatalf("memory = code %d stderr %q", code, stderr)
	}
	want := "pid: 4242\nbunVersion: 1.3.14\nplatform: linux\nuptimeSeconds: 123.456\nrss: 104857600\nheapUsed: 33554432\nobservedMetric: rss\njscHeap.heapSize: 33554432\njscHeap.objectCount: 1024\nresponseState.count: 0\nappOwnedBytes.budgetBytes: 268435456\nappOwnedBytes.stores: [object Object]\nappOwnedBytes.observedInFlight: 1, 2, 3\nstreamMode: auto\neagerRelay: -\nwatchdog.warnThresholdBytes: 4294967296\nwatchdog.samples: 1, 2\nisDraining: false\nfreeHeapRatioHistory: 0.5, , 0.4\n"
	if stdout != want {
		t.Fatalf("memory stdout = %q, want %q", stdout, want)
	}
}

func TestMemoryJSONMatchesStringifyIndent(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"memory", "--json"})
	if code != 0 || stderr != "" {
		t.Fatalf("memory --json = code %d stderr %q", code, stderr)
	}
	for _, want := range []string{
		"{\n  \"pid\": 4242,\n",
		"  \"uptimeSeconds\": 123.456,\n",
		"  \"eagerRelay\": null,\n",
		"  \"freeHeapRatioHistory\": [\n    0.5,\n    null,\n    0.4\n  ]\n}\n",
	} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("memory --json missing %q:\n%s", want, stdout)
		}
	}
	if !strings.HasSuffix(stdout, "\n") {
		t.Fatal("JSON output must end with a newline (console.log)")
	}
}

func TestLogsOutputMatchesTypeScriptFixture(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"logs"})
	if code != 0 || stderr != "" {
		t.Fatalf("logs = code %d stderr %q", code, stderr)
	}
	want := "1788818801331  502  fixture/fixture-model  344ms  conv=conv-abc-123\n2026-08-22T10:00:00Z  200  xai/grok-4.6\n"
	if stdout != want {
		t.Fatalf("logs stdout = %q, want %q", stdout, want)
	}
}

func TestLogsJSONLMatchesCompactStringify(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"logs", "--jsonl"})
	if code != 0 || stderr != "" {
		t.Fatalf("logs --jsonl = code %d stderr %q", code, stderr)
	}
	want := "{\"requestId\":\"ocx-1111111111\",\"timestamp\":1788818801331,\"provider\":\"fixture\",\"model\":\"fixture-model\",\"status\":502,\"durationMs\":344,\"conversationId\":\"conv-abc-123\"}\n{\"createdAt\":\"2026-08-22T10:00:00Z\",\"provider\":\"xai\",\"model\":\"grok-4.6\",\"statusCode\":200}\n"
	if stdout != want {
		t.Fatalf("logs --jsonl stdout = %q, want %q", stdout, want)
	}
}

func TestLogsFiltersAndLimitStillRenderRows(t *testing.T) {
	for _, argv := range [][]string{
		{"logs", "--provider", "fixture"},
		{"logs", "--status", "502"},
		{"logs", "--limit", "1"},
		{"logs", "--conversation", "conv-abc-123"},
	} {
		code, stdout, stderr := runReadWithFixture(t, argv)
		if code != 0 || stderr != "" {
			t.Fatalf("%v = code %d stderr %q", argv, code, stderr)
		}
		want := "1788818801331  502  fixture/fixture-model  344ms  conv=conv-abc-123\n2026-08-22T10:00:00Z  200  xai/grok-4.6\n"
		if stdout != want {
			t.Fatalf("%v stdout = %q, want %q", argv, stdout, want)
		}
	}
}

func TestLogsExplainMatchesTypeScriptFixture(t *testing.T) {
	for _, argv := range [][]string{{"logs", "explain", "req-1"}, {"logs", "explain", "req-1", "--json"}} {
		code, stdout, stderr := runReadWithFixture(t, argv)
		if code != 0 || stderr != "" {
			t.Fatalf("%v = code %d stderr %q", argv, code, stderr)
		}
		want := "{\n  \"requestId\": \"req-1\",\n  \"routeDecision\": {\n    \"version\": 1,\n    \"decisionId\": \"d1\",\n    \"candidates\": [\n      {\n        \"provider\": \"fixture\",\n        \"eligible\": true\n      }\n    ]\n  },\n  \"attemptSequence\": []\n}\n"
		if stdout != want {
			t.Fatalf("%v stdout = %q, want %q", argv, stdout, want)
		}
	}
}

func TestReadSummaryJoinNullAndEmptyElements(t *testing.T) {
	// summaryLines renders scalar arrays with Array.prototype.join semantics:
	// null/undefined elements become empty strings ([1, null, 2] → "1, , 2",
	// [null] → "none"), verified against the TS oracle in src/cli/runtime-api.ts.
	payload := `{"a":[1,null,2],"b":[],"c":["","x"],"d":[null],"e":[[2,3]],"f":["a",true,0]}`
	body, err := jsonwire.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(readSummaryLines(body), "\n")
	want := "a: 1, , 2\nb: none\nc: , x\nd: none\ne: 1 item(s)\nf: a, true, 0"
	if got != want {
		t.Fatalf("summary join = %q, want %q", got, want)
	}
}

func TestInspectConfigOutputMatchesTypeScriptFixture(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"inspect"})
	if code != 0 || stderr != "" {
		t.Fatalf("inspect = code %d stderr %q", code, stderr)
	}
	want := "port: 10100\ndefaultProvider: fixture\ncodexAutoStart: true\nproviders.fixture: [object Object]\ntiers: -\n"
	if stdout != want {
		t.Fatalf("inspect stdout = %q, want %q", stdout, want)
	}
}

func TestInspectRoutingAnalyticsOutputMatchesTypeScriptFixture(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"inspect", "routing-analytics"})
	if code != 0 || stderr != "" {
		t.Fatalf("routing-analytics = code %d stderr %q", code, stderr)
	}
	want := "generatedAt: 1788818834015\ntotalRequests: 1\nconfidence: low\nsuccessRate: 0\nfailureRate: 1\ndurationMs.p50: 344\ndurationMs.sampleCount: 1\nbreakdown: 1 item(s)\nprofileBreakdown: none\npriceCoverage: -\nestimatedCostUsdPerSuccessfulRequest: -\n"
	if stdout != want {
		t.Fatalf("routing-analytics stdout = %q, want %q", stdout, want)
	}
}

func TestInspectPacingNameFilterAndCodexPromptText(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"inspect", "pacing", "--name", "fixture"})
	if code != 0 || stderr != "" {
		t.Fatalf("pacing = code %d stderr %q", code, stderr)
	}
	if want := "fixture.provider: fixture\nfixture.enabled: false\nfixture.queued: 0\nfixture.nextSlotInMs: 0\n"; stdout != want {
		t.Fatalf("pacing stdout = %q, want %q", stdout, want)
	}
	code, stdout, stderr = runReadWithFixture(t, []string{"inspect", "codex-prompt", "--text"})
	if code != 0 || stderr != "" {
		t.Fatalf("codex-prompt --text = code %d stderr %q", code, stderr)
	}
	if want := "You are Codex, the world's most advanced coding agent.\n\n"; stdout != want {
		t.Fatalf("codex-prompt --text stdout = %q, want %q", stdout, want)
	}
}

func TestInspectStarAppendsReadOnlyNoteInHumanModeOnly(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"inspect", "star"})
	if code != 0 || stderr != "" {
		t.Fatalf("star = code %d stderr %q", code, stderr)
	}
	want := "state: not-starred\nrepo: waxiangzi/opencodex\nurl: https://github.com/waxiangzi/opencodex\nStarring is not available from the CLI: it uses your GitHub identity, so only you can do it from the dashboard.\n"
	if stdout != want {
		t.Fatalf("star stdout = %q, want %q", stdout, want)
	}
	code, stdout, stderr = runReadWithFixture(t, []string{"inspect", "star", "--json"})
	if code != 0 || stderr != "" {
		t.Fatalf("star --json = code %d stderr %q", code, stderr)
	}
	if strings.Contains(stdout, "Starring is not available") {
		t.Fatalf("star --json must not carry the human note:\n%s", stdout)
	}
	if !strings.Contains(stdout, "\"state\": \"not-starred\"") {
		t.Fatalf("star --json stdout = %q", stdout)
	}
}

func TestReadArgumentValidationExits2WithUsage(t *testing.T) {
	cases := []struct {
		args        []string
		message     string
		usageMarker string
		noUsage     bool
	}{
		{args: []string{"logs", "extra"}, message: "Unexpected argument(s): extra", usageMarker: "ocx observe logs [--provider"},
		{args: []string{"logs", "--json", "--jsonl"}, message: "--json and --jsonl cannot be combined", usageMarker: "ocx observe logs [--provider"},
		{args: []string{"logs", "--follow", "--json"}, message: "--follow cannot be combined with --json; use --jsonl for streaming JSONL", usageMarker: "ocx observe logs [--provider"},
		{args: []string{"logs", "--provider"}, message: "--provider requires a value", noUsage: true},
		{args: []string{"logs", "--limit", "0"}, message: "--limit must be an integer >= 1", noUsage: true},
		{args: []string{"logs", "--limit", "abc"}, message: "--limit must be an integer >= 1", noUsage: true},
		{args: []string{"memory", "extra"}, message: "Unexpected argument(s): extra", usageMarker: "ocx observe logs [--provider"},
		{args: []string{"memory", "--limit", "x"}, message: "--limit must be an integer >= 1", noUsage: true},
		{args: []string{"logs", "explain"}, message: "request id is required", usageMarker: "ocx observe logs [--provider"},
		{args: []string{"inspect", "nope"}, message: "unknown inspect command nope", usageMarker: "ocx inspect config [--json]"},
		{args: []string{"inspect", "client-config"}, message: "--client is required", usageMarker: "ocx inspect config [--json]"},
		{args: []string{"inspect", "client-config", "--client"}, message: "--client requires a value", noUsage: true},
		{args: []string{"inspect", "codex-prompt", "--text", "--json"}, message: "--text and --json cannot be combined", usageMarker: "ocx inspect config [--json]"},
		{args: []string{"inspect", "codex-prompt", "extra"}, message: "Unexpected argument(s): extra", usageMarker: "ocx inspect config [--json]"},
		{args: []string{"inspect", "pacing", "--name"}, message: "--name requires a value", noUsage: true},
		{args: []string{"inspect", "--bogus"}, message: "Unexpected argument(s): --bogus", usageMarker: "ocx inspect config [--json]"},
		{args: []string{"inspect", "config", "--json", "extra"}, message: "Unexpected argument(s): extra", usageMarker: "ocx inspect config [--json]"},
	}
	for _, testCase := range cases {
		var stdout, stderr bytes.Buffer
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, errors.New("unused") }}
		code := Run(testCase.args, deps)
		if code != readExitUsage {
			t.Fatalf("args %v exit = %d, want %d (stderr: %s)", testCase.args, code, readExitUsage, stderr.String())
		}
		if !strings.Contains(stderr.String(), "Error: "+testCase.message) {
			t.Fatalf("args %v stderr missing %q:\n%s", testCase.args, testCase.message, stderr.String())
		}
		if testCase.noUsage {
			if strings.Contains(stderr.String(), "Usage:") {
				t.Fatalf("args %v stderr must not carry the USAGE block:\n%s", testCase.args, stderr.String())
			}
		} else if !strings.Contains(stderr.String(), testCase.usageMarker) {
			t.Fatalf("args %v stderr missing USAGE block %q:\n%s", testCase.args, testCase.usageMarker, stderr.String())
		}
	}
}

func TestReadWithoutRuntimeReportsStartHint(t *testing.T) {
	for _, argv := range [][]string{{"logs"}, {"memory"}, {"inspect"}} {
		var stdout, stderr bytes.Buffer
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, os.ErrNotExist }}
		code := Run(argv, deps)
		if code != 1 {
			t.Fatalf("%v exit = %d, want 1", argv, code)
		}
		if strings.TrimSpace(stderr.String()) != "Error: Proxy is not running. Start it with: ocx start" {
			t.Fatalf("%v stderr = %q", argv, stderr.String())
		}
	}
}

func TestReadHTTPErrorBodyComposesReasonAndHint(t *testing.T) {
	server := readFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"bad key","hint":"run ocx auth login"}`)
	})
	deps, _, stderr := readDeps(t, server)
	code := runInspect([]string{"config"}, deps)
	if code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	stderrText := stderr.String()
	for _, want := range []string{"Error: bad key", "hint: run ocx auth login"} {
		if !strings.Contains(stderrText, want) {
			t.Fatalf("stderr missing %q:\n%s", want, stderrText)
		}
	}
}

func TestRead404JSONBodyExits4(t *testing.T) {
	server := readFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error":"missing state"}`)
	})
	deps, _, stderr := readDeps(t, server)
	if code := runMemory(nil, deps); code != readExitNotFound {
		t.Fatalf("memory 404 exit = %d, want %d", code, readExitNotFound)
	}
	if strings.TrimSpace(stderr.String()) != "Error: missing state" {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestReadNonJSONBodyReportsRawText(t *testing.T) {
	server := readFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, "indexer exploded")
	})
	deps, _, stderr := readDeps(t, server)
	if code := runLogs([]string{}, deps); code != 1 {
		t.Fatalf("logs 500 exit = %d, want 1", code)
	}
	if strings.TrimSpace(stderr.String()) != "Error: indexer exploded" {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestLogsIndexMaintenanceSubcommandsDelegateToTypeScriptOwner(t *testing.T) {
	for _, subcommand := range []string{"rebuild-index", "index-status"} {
		var stdout, stderr bytes.Buffer
		var received []string
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, errors.New("unused") }}
		deps.Delegate = func(args []string) (int, error) { received = append([]string(nil), args...); return 17, nil }
		if got := Run([]string{"logs", subcommand}, deps); got != 17 {
			t.Fatalf("logs %s exit = %d, want delegated 17", subcommand, got)
		}
		if want := []string{"logs", subcommand}; !slices.Equal(received, want) {
			t.Fatalf("delegated argv = %#v, want %#v", received, want)
		}
	}
}

func TestLogsExplainIsGoOwnedAndDoesNotDelegate(t *testing.T) {
	code, stdout, stderr := runReadWithFixture(t, []string{"logs", "explain", "req-1"})
	if code != 0 || stderr != "" || !strings.Contains(stdout, "\"requestId\": \"req-1\"") {
		t.Fatalf("logs explain = code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

func TestReadCommandHelpsMatchRegistry(t *testing.T) {
	for _, name := range []string{"logs", "memory", "inspect"} {
		var stdout, stderr bytes.Buffer
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr}
		if got := Run([]string{"help", name}, deps); got != ExitOK {
			t.Fatalf("help %s exit = %d", name, got)
		}
		var command Command
		for _, candidate := range Commands {
			if candidate.Name == name {
				command = candidate
			}
		}
		want := "Usage: " + command.Usage + "\n\n" + command.Summary + "\n"
		for _, detail := range command.Details {
			want += "\n" + detail + "\n"
		}
		if stdout.String() != want {
			t.Fatalf("help %s stdout = %q, want %q", name, stdout.String(), want)
		}
	}
}

func TestFollowLogSeenTrimKeepsNewestInsertionOrder(t *testing.T) {
	// TS follow mode rebuilds its dedupe Set from [...seen].slice(-2500) once it
	// passes 5000 unique rows; the Go tracker must keep the same insertion order
	// so a row still inside the rolling /api/logs window is never reprinted.
	tracker := newFollowLogSeen()
	for i := 0; i < followLogTrimAt+200; i++ {
		if !tracker.add(fmt.Sprintf("k-%d", i)) {
			t.Fatalf("first insert of k-%d rejected", i)
		}
	}
	if tracker.add("k-0") {
		t.Fatal("repeat insert must be rejected")
	}
	if len(tracker.order) != followLogTrimAt+200 || len(tracker.seen) != followLogTrimAt+200 {
		t.Fatalf("pre-trim size = %d/%d", len(tracker.order), len(tracker.seen))
	}
	tracker.trim()
	wantSize := followLogKeep
	if len(tracker.order) != wantSize || len(tracker.seen) != wantSize {
		t.Fatalf("post-trim size = %d/%d, want %d", len(tracker.order), len(tracker.seen), wantSize)
	}
	if tracker.order[0] != "k-2700" || tracker.order[wantSize-1] != "k-5199" {
		t.Fatalf("trim kept the wrong tail: first=%q last=%q", tracker.order[0], tracker.order[wantSize-1])
	}
	if !tracker.seen["k-2700"] || tracker.seen["k-2699"] {
		t.Fatal("trim boundary kept/dropped the wrong key")
	}
	// A row dropped by the trim is eligible to be printed again (it was out of
	// the window), which must re-insert it at the newest end.
	if !tracker.add("k-2699") {
		t.Fatal("dropped key must be re-insertable")
	}
	if len(tracker.order) != wantSize+1 {
		t.Fatalf("re-insert grew the window to %d, want %d", len(tracker.order), wantSize+1)
	}
	if tracker.order[len(tracker.order)-1] != "k-2699" {
		t.Fatal("re-inserted key must land at the newest end")
	}
}

func TestReadJSONEmptyBodyPrintsNull(t *testing.T) {
	// A 2xx empty body parses to JS null in the TS runtime (only non-empty text
	// is parsed), so printData emits JSON.stringify(null) = "null"; a non-JSON
	// body prints the quoted text instead.
	var out bytes.Buffer
	if err := writeUsageJSON(&out, nil, ""); err != nil {
		t.Fatal(err)
	}
	if out.String() != "null\n" {
		t.Fatalf("empty body JSON = %q, want %q", out.String(), "null\n")
	}
	out.Reset()
	if err := writeUsageJSON(&out, nil, "not json"); err != nil {
		t.Fatal(err)
	}
	if out.String() != "\"not json\"\n" {
		t.Fatalf("non-JSON body JSON = %q, want %q", out.String(), "\"not json\"\n")
	}
}
