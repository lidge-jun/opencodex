package ocxcli

import (
	"bytes"
	"strings"
	"testing"
)

// The capabilities/observe/export families flipped to Go-owned dispatch in the
// same ticket; the parity suite locks byte-for-byte output against TypeScript,
// and these fast unit tests lock ownership routing and exit taxonomy without a
// live proxy (ADR-0008 issue #46).
func TestObserveAndExportOwnershipMap(t *testing.T) {
	if got, known := OwnershipFor([]string{"capabilities"}); !known || got != GoOwned {
		t.Fatalf("capabilities owner = %q, %t", got, known)
	}
	if got, known := OwnershipFor([]string{"export"}); !known || got != GoOwned {
		t.Fatalf("export owner = %q, %t", got, known)
	}
	for verb, owner := range map[string]Ownership{
		"logs":           GoOwned,
		"usage":          GoOwned,
		"storage":        GoOwned,
		"memory":         GoOwned,
		"debug":          GoOwned,
		"claude-inbound": GoOwned,
		"injection":      GoOwned,
		"wat":            GoOwned,
	} {
		if got, known := OwnershipFor([]string{"observe", verb}); !known || got != owner {
			t.Fatalf("observe %s owner = %q, %t", verb, got, known)
		}
	}
	// The request-history indexer reads/writes the Bun:sqlite index directly
	// (no management route), so it keeps the TypeScript owner at the action.
	for _, action := range []string{"logs rebuild-index", "logs index-status"} {
		args := strings.Split(action, " ")
		if got, known := OwnershipFor(append([]string{"observe"}, args...)); !known || got != TypeScriptOwned {
			t.Fatalf("observe %s owner = %q, %t (want TypeScriptOwned seam)", action, got, known)
		}
	}
}

func TestCapabilitiesNativeStaticExitCodes(t *testing.T) {
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("capabilities delegated"); return 0, nil }
	if got := Run([]string{"capabilities"}, deps); got != ExitOK || out.Len() == 0 {
		t.Fatalf("capabilities exit = %d stderr %q", got, stderr.String())
	}
	out.Reset()
	stderr.Reset()
	if got := Run([]string{"capabilities", "--route", "/api/nope"}, deps); got != 4 {
		t.Fatalf("unmatched --route exit = %d (want 4)", got)
	}
	stderr.Reset()
	if got := Run([]string{"capabilities", "--route"}, deps); got != 64 {
		t.Fatalf("empty --route exit = %d (want 64)", got)
	}
	if !strings.Contains(stderr.String(), "Usage: ocx capabilities --route <path>") {
		t.Fatalf("empty --route stderr = %q", stderr.String())
	}
}

func TestObserveUnknownSubcommandIsUsageErrorTwo(t *testing.T) {
	var out, stderr bytes.Buffer
	deps := depsFor(RuntimeState{}, &out, &stderr)
	deps.Delegate = func([]string) (int, error) { t.Fatal("observe wat delegated"); return 0, nil }
	if got := Run([]string{"observe", "wat"}, deps); got != usageExitUsage {
		t.Fatalf("observe wat exit = %d stderr %q", got, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Error: unknown observe command wat") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestExportArgumentErrorsAndOfflineProxy(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	run := func(args ...string) (int, string) {
		var out, stderr bytes.Buffer
		deps := depsFor(RuntimeState{}, &out, &stderr)
		deps.Delegate = func([]string) (int, error) { t.Fatal("export delegated"); return 0, nil }
		return Run(args, deps), stderr.String()
	}
	if code, message := run("export", "--client", "nope"); code != usageExitUsage ||
		!strings.Contains(message, "--client must be one of:") || !strings.Contains(message, "Usage:") {
		t.Fatalf("bad client = %d %q", code, message)
	}
	if code, message := run("export", "--client"); code != usageExitUsage ||
		!strings.Contains(message, "--client requires a value") || strings.Contains(message, "Usage:") {
		t.Fatalf("missing value = %d %q", code, message)
	}
	if code, message := run("export", "--client", "pi"); code != ExitFailure ||
		!strings.Contains(message, "Proxy is not running. Start it with: ocx start") {
		t.Fatalf("offline export = %d %q", code, message)
	}
}

// json5String must mirror Bun.JSON5.stringify's single-quoted stringifier
// exactly — parity fixtures only ever see clean identifiers, so the exotic
// escape surface (NUL, C0 controls, DEL, the JSON-forbidden line separators)
// is pinned here against observed Bun output instead.
func TestExportJSON5StringMatchesBunEscapes(t *testing.T) {
	expect := func(input, want string) {
		t.Helper()
		if got := json5String(input); got != want {
			t.Fatalf("json5String(%q) = %q, want %q", input, got, want)
		}
	}
	expect("O'Brien", `'O\'Brien'`)
	expect(`say "hi"`, `'say "hi"'`)
	expect("back\\slash", `'back\\slash'`)
	expect("tab\there", `'tab\there'`)
	expect("nl\nhere", `'nl\nhere'`)
	expect("cr\rx", `'cr\rx'`)
	expect("vtab\x0bx", `'vtab\vx'`)
	expect("bell\x07x", `'bell\x07x'`)
	expect("\x00nul", `'\0nul'`)
	expect("del\x7fx", `'del\x7fx'`)
	expect("ctrl\u0001x", `'ctrl\x01x'`)
	expect("esc\x1bx", `'esc\x1bx'`)
	expect("ls\u2028ps\u2029", `'ls\u2028ps\u2029'`)
	expect("中文 🌍", `'中文 🌍'`)
	expect("endback\\", `'endback\\'`)
	expect("", `''`)
}
