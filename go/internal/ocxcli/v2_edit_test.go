package ocxcli

// v2_edit_test.go — byte-level golden tests for the v2 write engine (issue
// #56, slice v2b). Expected outputs are the TypeScript features.ts results for
// the identical inputs (generated with /tmp/v2edit_oracle.mjs), so a drift in
// either implementation fails here before the parity rows ever run.

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func v2TestWrite(t *testing.T, toml string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if toml != "" {
		if err := os.WriteFile(path, []byte(toml), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// v2TestFakeToggle mirrors the oracle fakeToggle: flip the FIRST
// `enabled = bool` line, else append a fresh dedicated table.
func v2TestFakeToggle(path string, enable bool) error {
	content, ok := readCodexConfigTextAt(path)
	if !ok {
		return os.ErrNotExist
	}
	re := regexp.MustCompile(`(enabled\s*=\s*)(true|false)`)
	loc := re.FindStringSubmatchIndex(content)
	if loc != nil {
		next := content[:loc[0]] + content[loc[2]:loc[3]] + strconv.FormatBool(enable) + content[loc[1]:]
		return atomicWriteTextFile(path, next)
	}
	return atomicWriteTextFile(path, content+"\n[features.multi_agent_v2]\nenabled = "+strconv.FormatBool(enable)+"\n")
}

func readV2Test(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content)
}

func TestV2SetMaxConcurrentThreadsGolden(t *testing.T) {
	cases := []struct {
		name     string
		toml     string
		value    int64
		migrated string
		want     string
		changed  bool
	}{
		{
			name:  "dedicated replace",
			toml:  "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 4\n",
			value: 8,
			want:  "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 8\n",
		},
		{
			name:  "dedicated insert before enabled",
			toml:  "[features.multi_agent_v2]\nenabled = true\n",
			value: 8,
			want:  "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 8\nenabled = true\n",
		},
		{
			name:  "features boolean upgraded inline",
			toml:  "[features]\nmulti_agent_v2 = true\n",
			value: 8,
			want:  "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 }\n",
		},
		{
			name:  "inline replace",
			toml:  "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 4 }\n",
			value: 8,
			want:  "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 }\n",
		},
		{
			name:  "inline append",
			toml:  "[features]\nmulti_agent_v2 = { enabled = true }\n",
			value: 8,
			want:  "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 }\n",
		},
		{
			name:  "inline irregular spacing",
			toml:  "[features]\nmulti_agent_v2 = {enabled = true,  max_concurrent_threads_per_session = 4}\n",
			value: 8,
			want:  "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 }\n",
		},
		{
			name:     "dedicated comment merged",
			toml:     "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 4  # legacy\n",
			value:    8,
			migrated: " # migrated",
			want:     "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 8  # legacy; migrated\n",
		},
		{
			name:  "crlf preserved",
			toml:  "[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 4\r\n",
			value: 8,
			want:  "[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 8\r\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := v2TestWrite(t, tc.toml)
			result := setCodexMaxConcurrentThreads(tc.value, path, tc.migrated)
			if !result.ok {
				t.Fatalf("setCodexMaxConcurrentThreads = %+v; want ok", result)
			}
			if got := readV2Test(path); got != tc.want {
				t.Errorf("output mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, tc.want)
			}
		})
	}
}

func TestV2TransitionGolden(t *testing.T) {
	toggle := func(path string) func(enable bool) error {
		return func(enable bool) error { return v2TestFakeToggle(path, enable) }
	}
	cases := []struct {
		name       string
		toml       string
		enable     bool
		thread     int64
		hasThread  bool
		want       string
		wantResult string // JSON of the ok/changed/threadLimit projection
	}{
		{
			name:       "enable from legacy threads migrates limit",
			toml:       "[agents]\nmax_threads = 4\n",
			enable:     true,
			want:       "[agents]\n\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 5\n",
			wantResult: `{"ok":true,"changed":true,"threadLimit":5}`,
		},
		{
			name:       "enable with no stored limit",
			toml:       "[other]\nx = 1\n",
			enable:     true,
			want:       "[other]\nx = 1\n\n[features.multi_agent_v2]\nenabled = true\n",
			wantResult: `{"ok":true,"changed":true,"threadLimit":null}`,
		},
		{
			name:       "enable from disabled dedicated",
			toml:       "[features.multi_agent_v2]\nenabled = false\n",
			enable:     true,
			want:       "[features.multi_agent_v2]\nenabled = true\n",
			wantResult: `{"ok":true,"changed":true,"threadLimit":null}`,
		},
		{
			name:       "explicit thread limit kept",
			toml:       "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 4\n",
			enable:     true,
			thread:     12,
			hasThread:  true,
			want:       "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 12\n",
			wantResult: `{"ok":true,"changed":true,"threadLimit":12}`,
		},
		{
			name:       "disable migrates v2 limit to agents",
			toml:       "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 4\n",
			enable:     false,
			want:       "[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_threads = 3",
			wantResult: `{"ok":true,"changed":true,"threadLimit":3}`,
		},
		{
			name:       "disable on already-v1 config is a no-op",
			toml:       "[agents]\nmax_threads = 3\n",
			enable:     false,
			want:       "[agents]\nmax_threads = 3\n",
			wantResult: `{"ok":true,"changed":false,"threadLimit":3}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := v2TestWrite(t, tc.toml)
			result := transitionCodexMultiAgentV2(tc.enable, toggle(path), path, tc.thread, tc.hasThread)
			if !result.ok {
				t.Fatalf("transition = %+v; want ok (err %q)", result, result.err)
			}
			gotResult := resultProjection(result)
			if gotResult != tc.wantResult {
				t.Errorf("result = %s; want %s", gotResult, tc.wantResult)
			}
			if got := readV2Test(path); got != tc.want {
				t.Errorf("output mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, tc.want)
			}
		})
	}
}

func resultProjection(r v2TransitionResult) string {
	if !r.ok {
		return `{"ok":false}`
	}
	limit := "null"
	if r.hasThread {
		limit = strconv.FormatInt(r.threadLimit, 10)
	}
	return `{"ok":true,"changed":` + strconv.FormatBool(r.changed) + `,"threadLimit":` + limit + `}`
}

// A thread limit out of translatable range aborts before any toggle.
func TestV2TransitionOutOfRangeRefused(t *testing.T) {
	path := v2TestWrite(t, "[agents]\nmax_threads = 2000001\n")
	var toggled bool
	result := transitionCodexMultiAgentV2(true, func(bool) error {
		toggled = true
		return nil
	}, path, 0, false)
	if result.ok {
		t.Fatalf("transition = %+v; want out-of-range refusal", result)
	}
	if toggled {
		t.Fatal("toggle ran before range check")
	}
	if got := readV2Test(path); got != "[agents]\nmax_threads = 2000001\n" {
		t.Fatalf("config mutated on refusal: %q", got)
	}
}

// A failed toggle restores the exact original bytes (rollback contract).
func TestV2TransitionToggleFailureRollsBack(t *testing.T) {
	original := "[agents]\nmax_threads = 4\n"
	path := v2TestWrite(t, original)
	result := transitionCodexMultiAgentV2(true, func(bool) error {
		return errors.New("boom")
	}, path, 0, false)
	_ = result
	if result.ok {
		t.Fatalf("transition = %+v; want failure", result)
	}
	if !strings.Contains(result.err, "boom") {
		t.Fatalf("err = %q; want toggle failure surfaced", result.err)
	}
	if got := readV2Test(path); got != original {
		t.Fatalf("rollback mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, original)
	}
}
