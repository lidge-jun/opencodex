package ocxcli

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

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// The fixture payloads mirror tests/cli-usage-report.test.ts so the Go renderer
// is diffed against the same shapes the TypeScript oracle pins.

func usageFixturePayload() string {
	return `{
  "range": "today",
  "surface": "all",
  "since": 1756000000000,
  "summary": {
    "requests": 1447,
    "totalTokens": 178521375,
    "inputTokens": 4489102,
    "outputTokens": 1283441,
    "cachedInputTokens": 172748832,
    "estimatedCostUsd": 12.3456,
    "unpricedRequests": 0,
    "unmeteredRequests": 0
  },
  "providers": [{"provider": "xai", "requests": 1447, "totalTokens": 178521375, "estimatedCostUsd": 12.3456}],
  "models": [{"provider": "xai", "model": "grok-4.6", "requests": 1447, "totalTokens": 178521375, "estimatedCostUsd": 12.3456}],
  "days": [{"date": "2026-08-22", "requests": 1447, "totalTokens": 178521375, "estimatedCostUsd": 12.3456}],
  "accounts": []
}`
}

// usageFixtureServer serves an attested /healthz identity probe (the
// findLiveProxy gate) plus a canned /api/usage response.
func usageFixtureServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
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

func atoi(t *testing.T, value string) int {
	t.Helper()
	number := 0
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			t.Fatalf("non-numeric port %q", value)
		}
		number = number*10 + int(digit-'0')
	}
	return number
}

func TestUsageRendererMatchesTypeScriptFixture(t *testing.T) {
	body, err := jsonwire.Parse([]byte(usageFixturePayload()))
	if err != nil {
		t.Fatal(err)
	}
	lines := formatUsageReportLines(viewUsageReport(body))
	out := strings.Join(lines, "\n")
	for _, want := range []string{
		"Usage — today",
		"Requests   1,447",
		"Tokens     178,521,375  (in 4,489,102 / out 1,283,441 / cached 172,748,832)",
		"Est. cost  ~$12.3456    API list-price equivalent (this range)",
		"PROVIDER  ",
		"grok-4.6",
		"Not a billing receipt. Subscription usage or provider credits may apply instead.",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("usage rendering missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "item(s)") {
		t.Fatalf("usage rendering regressed to the flattener:\n%s", out)
	}
}

func TestUsageRendererTerminalTextIsInert(t *testing.T) {
	control := "demo-\\u001b]52;c;SGVsbG8=\\u0007-after\\nnext\\u007f-\\u0080"
	payload := fmt.Sprintf(`{"range":"today","summary":{"requests":1,"totalTokens":2,"estimatedCostUsd":0},"providers":[{"provider":"%s","requests":1,"totalTokens":2}],"models":[{"provider":"%s","model":"%s","requests":1,"totalTokens":2}],"filter":{"provider":"%s","model":"%s","matched":true,"comboOverlap":false}}`, control, control, control, control, control)
	body, err := jsonwire.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	out := strings.Join(formatUsageReportLines(viewUsageReport(body)), "\n")
	// U+0080 is matched by the TS [\x7f-\x9f] class and must render as \u0080;
	// compare it separately because a raw 0x80 byte is not valid UTF-8 in Go.
	escaped := usageTerminalText("demo-\x1b]52;c;SGVsbG8=\x07-after\nnext\x7f")
	if !strings.Contains(out, escaped) {
		t.Fatalf("rendering lost the escaped control text %q:\n%s", escaped, out)
	}
	if !strings.Contains(out, `\u0080`) {
		t.Fatalf("U+0080 must render as \\u0080 like the TS oracle:\n%s", out)
	}
	if !strings.Contains(out, `\x0anext`) {
		t.Fatalf("LF inside a label must be escaped like the TS oracle (\\x0a):\n%s", out)
	}
	for _, banned := range []string{"\x1b", "\x07", "\x7f"} {
		if strings.Contains(out, banned) {
			t.Fatalf("rendering emitted raw control character %q:\n%s", banned, out)
		}
	}
}

func TestUsageUnmatchedFilterMessage(t *testing.T) {
	payload := `{"range":"today","summary":{"requests":0,"totalTokens":0,"estimatedCostUsd":0},"providers":[],"models":[],"days":[],"filter":{"provider":"nope","model":null,"matched":false,"comboOverlap":false}}`
	body, err := jsonwire.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	out := strings.Join(formatUsageReportLines(viewUsageReport(body)), "\n")
	want := "No usage recorded for provider \"nope\" in this range."
	if !strings.Contains(out, want) {
		t.Fatalf("missing unmatched-filter message %q:\n%s", want, out)
	}
}

func TestUsageAccountsWithheldUnderFilter(t *testing.T) {
	payload := `{"range":"today","summary":{"requests":2,"totalTokens":10,"estimatedCostUsd":1},"providers":[{"provider":"p","requests":2,"totalTokens":10,"estimatedCostUsd":1}],"accounts":[{"accountLogLabel":"acct@example","requests":2,"totalTokens":10,"estimatedCostUsd":1}],"filter":{"provider":"p","model":null,"matched":true,"comboOverlap":false}}`
	body, err := jsonwire.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	out := strings.Join(formatUsageReportLines(viewUsageReport(body)), "\n")
	if !strings.Contains(out, "ACCOUNT: not reported under a provider or model filter") {
		t.Fatalf("missing withheld-account note:\n%s", out)
	}
}

func TestUsageAmbiguousAccountMarked(t *testing.T) {
	payload := `{"range":"today","summary":{"requests":2,"totalTokens":10,"estimatedCostUsd":1},"accounts":[{"accountLogLabel":"label","ambiguous":true,"requests":2,"totalTokens":10,"estimatedCostUsd":1}]}`
	body, err := jsonwire.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	out := strings.Join(formatUsageReportLines(viewUsageReport(body)), "\n")
	if !strings.Contains(out, "label (ambiguous)") {
		t.Fatalf("missing ambiguous marker:\n%s", out)
	}
}

func TestUsageJSONMatchesStringifyIndent(t *testing.T) {
	body, err := jsonwire.Parse([]byte(usageFixturePayload()))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	deps := Deps{Version: "test", Stdout: &out, Stderr: &bytes.Buffer{}, HTTPClient: http.DefaultClient}
	if err := writeUsageJSON(deps.Stdout, body, ""); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if !strings.HasSuffix(text, "\n") {
		t.Fatal("JSON output must end with a newline (console.log)")
	}
	for _, want := range []string{
		"\"estimatedCostUsd\": 12.3456",
		"\"totalTokens\": 178521375",
		"  \"providers\": [",
		"    \"provider\": \"xai\"",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("JSON output missing %q:\n%s", want, text)
		}
	}
}

func TestUsageArgumentValidationExits2WithUsage(t *testing.T) {
	cases := []struct {
		args      []string
		message   string
		wantUsage bool
	}{
		{args: []string{"--range", "nope"}, message: "--range must be one of today, 7d, 30d, all (1d aliases today)", wantUsage: true},
		{args: []string{"--surface", "beard"}, message: "--surface must be one of all, codex, claude, grok", wantUsage: true},
		{args: []string{"--range"}, message: "--range requires a value"},
		{args: []string{"extra"}, message: "Unexpected argument(s): extra", wantUsage: true},
	}
	for _, testCase := range cases {
		var stdout, stderr bytes.Buffer
		deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, errors.New("unused") }}
		code := runUsage(testCase.args, deps)
		if code != usageExitUsage {
			t.Fatalf("args %v exit = %d, want %d (stderr: %s)", testCase.args, code, usageExitUsage, stderr.String())
		}
		if !strings.Contains(stderr.String(), "Error: "+testCase.message) {
			t.Fatalf("args %v stderr missing %q:\n%s", testCase.args, testCase.message, stderr.String())
		}
		if testCase.wantUsage && !strings.Contains(stderr.String(), "ocx observe usage [--range") {
			t.Fatalf("args %v stderr missing USAGE block:\n%s", testCase.args, stderr.String())
		}
		if !testCase.wantUsage && strings.Contains(stderr.String(), "Usage:") {
			t.Fatalf("args %v stderr must not carry the USAGE block:\n%s", testCase.args, stderr.String())
		}
	}
}

func TestUsageWithoutRuntimeReportsStartHint(t *testing.T) {
	var stdout, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return RuntimeState{}, os.ErrNotExist }}
	code := runUsage(nil, deps)
	if code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if strings.TrimSpace(stderr.String()) != "Error: Proxy is not running. Start it with: ocx start" {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestUsageHTTPErrorBodyComposesReasonAndHint(t *testing.T) {
	server := usageFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"opencodex admin token required","reason":"no token","hint":"Set OPENCODEX_ADMIN_AUTH_TOKEN to bypass file-backed admin token ACL hardening"}`)
	})
	port := server.URL[len("http://127.0.0.1:"):]
	runtimeState := RuntimeState{PID: 1, Port: atoi(t, port), Hostname: "127.0.0.1", AttestationSecret: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}
	var stdout, stderr bytes.Buffer
	deps := Deps{Version: "test", Stdout: &stdout, Stderr: &stderr, ReadRuntime: func() (RuntimeState, error) { return runtimeState, nil }, HTTPClient: server.Client()}
	t.Setenv("OPENCODEX_ADMIN_AUTH_TOKEN", "")
	code := runUsage(nil, deps)
	if code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	stderrText := stderr.String()
	for _, want := range []string{"Error: opencodex admin token required", "reason: no token", "hint: Set OPENCODEX_ADMIN_AUTH_TOKEN"} {
		if !strings.Contains(stderrText, want) {
			t.Fatalf("stderr missing %q:\n%s", want, stderrText)
		}
	}
}

func TestUsageAdminTokenHeaderFromEnvAndFile(t *testing.T) {
	var gotToken string
	server := usageFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-OpenCodex-API-Key")
		fmt.Fprint(w, usageFixturePayload())
	})
	port := server.URL[len("http://127.0.0.1:"):]
	runtimeState := RuntimeState{PID: 1, Port: atoi(t, port), Hostname: "127.0.0.1", AttestationSecret: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}

	t.Setenv("OPENCODEX_ADMIN_AUTH_TOKEN", "ocx_admin_envtoken")
	var stdout bytes.Buffer
	deps := Deps{Version: "test", Stdout: &stdout, Stderr: &bytes.Buffer{}, ReadRuntime: func() (RuntimeState, error) { return runtimeState, nil }, HTTPClient: server.Client()}
	if code := runUsage(nil, deps); code != 0 {
		t.Fatalf("env-token run exit = %d", code)
	}
	if gotToken != "ocx_admin_envtoken" {
		t.Fatalf("env token not sent, got %q", gotToken)
	}

	t.Setenv("OPENCODEX_ADMIN_AUTH_TOKEN", "")
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	tokenFile := filepath.Join(home, "admin-api-token")
	if err := os.WriteFile(tokenFile, []byte("ocx_admin_"+strings.Repeat("a", 43)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := runUsage(nil, deps); code != 0 {
		t.Fatalf("file-token run exit = %d", code)
	}
	if gotToken != "ocx_admin_"+strings.Repeat("a", 43) {
		t.Fatalf("file token not sent, got %q", gotToken)
	}
}
