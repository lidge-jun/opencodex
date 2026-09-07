package ocxcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestParsePidFile(t *testing.T) {
	cases := []struct {
		raw  string
		want int64
	}{
		{raw: "12345", want: 12345},
		{raw: "  12345\n", want: 12345},
		{raw: "007", want: 7},
		{raw: "0", want: 0},
		{raw: "12x", want: 0},
		{raw: "not-json", want: 0},
		{raw: "", want: 0},
		{raw: "   ", want: 0},
		{raw: "+7", want: 0},
		{raw: "-1", want: 0},
		{raw: "3.5", want: 0},
		{raw: "12 34", want: 0},
		{raw: "99999999999999999999", want: 0},
		// 2^53+1 exceeds TypeScript's safe-integer gate; Go int64 would keep
		// it, so the digit-length bound must reject it first.
		{raw: "9007199254740993", want: 0},
		{raw: "12\t", want: 12},
		{raw: "\n123", want: 123},
		{raw: "1_000", want: 0},
		{raw: "0x10", want: 0},
		// Arabic-Indic digits: \d in JS matches them, but the Go rune loop
		// accepts ASCII only. TypeScript trims them to null below because
		// parseInt... both sides must end at 0/null regardless of mechanism.
		{raw: "١٢٣", want: 0},
	}
	for _, tc := range cases {
		if got := parsePidFile(tc.raw); got != tc.want {
			t.Errorf("parsePidFile(%q) = %d, want %d", tc.raw, got, tc.want)
		}
	}
}

func TestIsOcxStartCommandLine(t *testing.T) {
	recognised := []string{
		"bun run src/cli.ts start",
		`"C:/tools/bun/bin/bun.exe" "run" "src/cli.ts" "start"`,
		"bun C:/tools/bun/install/global/node_modules/@bitkyc08/opencodex/src/cli.ts start",
		"opencodex start",
		"bun src/cli/index.ts start",
		`C:\Users\u\AppData\Roaming\npm\ocx.cmd start`,
		// npm's in-place global-update rename keeps a service wrapper pointed at
		// the hidden `.opencodex-*` directory while files move underneath it.
		"bun C:/tools/bun/install/global/node_modules/@bitkyc08/.opencodex-3f2a/src/cli/index.ts start",
		// The compiled Go runtime is its own process shape: it must stay
		// recognisable to stop/reclaim identity checks on every platform.
		"/usr/local/bin/ocx start",
		"/home/u/.opencodex/bin/opencodex start --port 10100",
	}
	for _, command := range recognised {
		if !isOcxStartCommandLine(command) {
			t.Errorf("isOcxStartCommandLine(%q) = false, want true", command)
		}
	}
	rejected := []string{
		"bun run src/cli.ts status",
		"bun test C:/work/opencodex/tests/config.test.ts",
		"notepad.exe",
		"ocx start-guard",
		"python server.py --flag ocx startx",
	}
	for _, command := range rejected {
		if isOcxStartCommandLine(command) {
			t.Errorf("isOcxStartCommandLine(%q) = true, want false", command)
		}
	}
}

func TestReadPidFileValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ocx.pid")
	if got := readPidFileValue(path); got != 0 {
		t.Fatalf("missing pid file value = %d, want 0", got)
	}
	if err := os.WriteFile(path, []byte("111"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readPidFileValue(path); got != 111 {
		t.Fatalf("pid file value = %d, want 111", got)
	}
	if err := os.WriteFile(path, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readPidFileValue(path); got != 0 {
		t.Fatalf("garbage pid file value = %d, want 0", got)
	}
}

func TestRemovePidIfValueIs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ocx.pid")
	if err := os.WriteFile(path, []byte("111"), 0o600); err != nil {
		t.Fatal(err)
	}
	removePidIfValueIs(path, 222)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("pid file removed for non-matching snapshot: %v", err)
	}
	removePidIfValueIs(path, 111)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("pid file kept for matching snapshot: %v", err)
	}
	// A missing file is a no-op, not an error.
	removePidIfValueIs(path, 111)
}

func TestRemoveRuntimePortIfPidIs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime-port.json")
	record, err := json.Marshal(StatusRuntimeRecord{PID: 111, Port: 10100, Hostname: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, record, 0o600); err != nil {
		t.Fatal(err)
	}
	removeRuntimePortIfPidIs(path, 222)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("runtime record removed for non-matching pid: %v", err)
	}
	removeRuntimePortIfPidIs(path, 111)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("runtime record kept for matching pid: %v", err)
	}
}

func TestRemoveRuntimeRecordsForOnlyClearsMatchingRecords(t *testing.T) {
	home := t.TempDir()
	pidPath := filepath.Join(home, "ocx.pid")
	runtimePath := filepath.Join(home, "runtime-port.json")
	if err := os.WriteFile(pidPath, []byte("42"), 0o600); err != nil {
		t.Fatal(err)
	}
	record, err := json.Marshal(StatusRuntimeRecord{PID: 43, Port: 10100, Hostname: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runtimePath, record, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := removeRuntimeRecordsFor(home, 42); err != nil {
		t.Fatalf("removeRuntimeRecordsFor: %v", err)
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatalf("pid file kept for matching pid: %v", err)
	}
	// A torn state pair (pid file 42, runtime record 43) must not lose the
	// runtime record a concurrent replacement runtime still owns.
	if _, err := os.Stat(runtimePath); err != nil {
		t.Fatalf("runtime record removed for non-matching pid: %v", err)
	}
}

func TestWriteStateFileAtomicPublishesExactBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ocx.pid")
	if err := os.WriteFile(path, []byte("stale-content"), 0o600); err != nil {
		t.Fatal(err)
	}
	payload := []byte(strconv.Itoa(os.Getpid()))
	if err := writeStateFileAtomic(path, payload); err != nil {
		t.Fatalf("writeStateFileAtomic: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(payload) {
		t.Fatalf("pid file bytes = %q, want %q (no trailing newline: byte parity with writePid)", raw, payload)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("pid file mode = %v, want 0600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".ocx-state-") {
			t.Fatalf("residual temp file %q left behind", entry.Name())
		}
	}
}
