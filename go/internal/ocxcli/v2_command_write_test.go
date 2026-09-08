package ocxcli

// v2_command_write_test.go — Go-owned `ocx v2` write verbs (issue #56 slice
// v2b). Each case runs with an isolated OPENCODEX_HOME + CODEX_HOME + PATH
// (the PATH holds a fake `codex features` shim that toggles config.toml), and
// the config fixture turns the Codex integration OFF so the trailing catalog
// resync takes sync.ts's silent desired-disabled branch — that keeps these
// rows machine/CI agnostic and never needs a real catalog or proxy.
//
// The expected texts are the TypeScript CLI's byte output for the same
// fixtures (verified end-to-end by the parity rows in
// tests/go-cli-parity.test.ts); config.toml edits are additionally oracle'd
// against the real features.ts engine by v2_edit_test.go / v2_strings_test.go.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

const v2BaseConfig = `{"clientIntegrations":{"codex":false},"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture"}`

const v2Shim = `#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo "codex 0.47.0"; exit 0; fi
if [ "${1:-}" = "features" ]; then
  f="${CODEX_HOME:-$HOME/.codex}/config.toml"
  case "${2:-}" in
    enable) sed -i '0,/enabled = false/s//enabled = true/' "$f" ;;
    disable) sed -i '0,/enabled = true/s//enabled = false/' "$f" ;;
  esac
  exit 0
fi
exit 1
`

// v2Env sets up an isolated HOME trio with the fake codex shim on PATH.
// toml is always written (empty string = an empty config.toml), matching a
// real Codex install where the file exists from the start.
func v2Env(t *testing.T, cfgJSON string, toml string) (shimDir string) {
	t.Helper()
	home := t.TempDir()
	codexHome := t.TempDir()
	shimDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(cfgJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(toml), 0o600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(shimDir, "codex")
	if err := os.WriteFile(shim, []byte(v2Shim), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("PATH", shimDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return shimDir
}

func v2Run(deps *Deps, out *bytes.Buffer, errOut *bytes.Buffer, args ...string) int {
	out.Reset()
	errOut.Reset()
	return runV2(args, *deps)
}

func v2Deps() Deps {
	return Deps{Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}, Delegate: nil}
}

func v2Toml(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(os.Getenv("CODEX_HOME"), "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func v2ConfigJSON(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(os.Getenv("OPENCODEX_HOME"), "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestV2FlipVerbsGolden(t *testing.T) {
	const offToml = "[features.multi_agent_v2]\nenabled = false\n"
	const onToml = "[features.multi_agent_v2]\nenabled = true\n"
	applies := "Applies to NEW sessions; running sessions keep their pinned multi-agent version. Restart the Codex app (or wait out its picker cache) to see the ladder change.\n"

	cases := []struct {
		name    string
		cfgJSON string
		toml    string
		args    []string
		want    string // full expected stdout
		// optional post-state checks
		wantToml    string
		wantCfgKeys map[string]any
	}{
		{
			name:    "on flips enabled false to true and prints the ladder lines",
			cfgJSON: v2BaseConfig,
			toml:    offToml,
			args:    []string{"on"},
			want: "multi_agent_v2: ON — global V2 override active\n" +
				"Applies to NEW sessions; running sessions keep their pinned multi-agent version. Restart the Codex app (or wait out its picker cache) to see the ladder change.\n",
			wantToml: onToml,
		},
		{
			name:    "on when already on is a no-op",
			cfgJSON: v2BaseConfig,
			toml:    onToml,
			args:    []string{"on"},
			want:    "multi_agent_v2 already ON — nothing to do.\n",
			wantToml: onToml,
		},
		{
			name:    "off flips enabled true to false",
			cfgJSON: v2BaseConfig,
			toml:    onToml,
			args:    []string{"off"},
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" + applies,
			wantToml: offToml,
		},
		{
			name:    "off when already off is a no-op",
			cfgJSON: v2BaseConfig,
			toml:    offToml,
			args:    []string{"off"},
			want:    "multi_agent_v2 already OFF — nothing to do.\n",
			wantToml: offToml,
		},
		{
			name:    "on refuses when mode v2 plus keep-native pin conflict",
			cfgJSON: `{"clientIntegrations":{"codex":false},"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture","multiAgentMode":"v2","keepNativeChatGptOnV1":true}`,
			toml:    offToml,
			args:    []string{"on"},
			want:    "",
			wantToml: offToml,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v2Env(t, tc.cfgJSON, tc.toml)
			deps := v2Deps()
			var out, errOut bytes.Buffer
			deps.Stdout, deps.Stderr = &out, &errOut
			code := v2Run(&deps, &out, &errOut, tc.args...)
			expectedCode := ExitOK
			if tc.want == "" {
				expectedCode = ExitFailure
			}
			if code != expectedCode {
				t.Fatalf("%v exit = %d, stderr = %q", tc.args, code, errOut.String())
			}
			if out.String() != tc.want {
				t.Errorf("%v stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", tc.args, out.String(), tc.want)
			}
			if tc.wantToml != "" && v2Toml(t) != tc.wantToml {
				t.Errorf("%v config.toml mismatch:\n--- got ---\n%s\n--- want ---\n%s", tc.args, v2Toml(t), tc.wantToml)
			}
		})
	}
}

func TestV2ModeVerbGolden(t *testing.T) {
	// Success paths only; the usage-error rows live in
	// TestV2WriteVerbErrorsGolden (bare `v2 mode` is the empty modeArg in TS
	// and fails the same list check as a bogus value).
	for _, modeArg := range []string{"default"} {
		t.Run("mode default removes the key", func(t *testing.T) {
			cfg := map[string]any{}
			if err := json.Unmarshal([]byte(`{"clientIntegrations":{"codex":false},"multiAgentMode":"v1","providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture"}`), &cfg); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(cfg)
			v2Env(t, string(raw), "[features.multi_agent_v2]\nenabled = false\n")
			deps := v2Deps()
			var out, errOut bytes.Buffer
			deps.Stdout, deps.Stderr = &out, &errOut
			code := v2Run(&deps, &out, &errOut, "mode", modeArg)
			if code != ExitOK {
				t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
			}
			want := "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
				"Applies to NEW sessions; running sessions keep their pinned multi-agent version.\n"
			if out.String() != want {
				t.Errorf("stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", out.String(), want)
			}
			if _, ok := v2ConfigJSON(t)["multiAgentMode"]; ok {
				t.Errorf("multiAgentMode key not removed from config.json")
			}
		})
	}
	for _, modeArg := range []string{"v1", "v2"} {
		t.Run("mode "+modeArg+" writes the key and prints the single-arg line", func(t *testing.T) {
			v2Env(t, v2BaseConfig, "[features.multi_agent_v2]\nenabled = true\n")
			deps := v2Deps()
			var out, errOut bytes.Buffer
			deps.Stdout, deps.Stderr = &out, &errOut
			code := v2Run(&deps, &out, &errOut, "mode", modeArg)
			if code != ExitOK {
				t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
			}
			line := "multi_agent_mode: " + modeArg
			if modeArg == "v2" {
				line += " — ALL models forced to v2 surface (upstream pins overridden)"
			} else {
				line += " — ALL models forced to v1 surface (upstream pins overridden)"
			}
			want := line + "\nApplies to NEW sessions; running sessions keep their pinned multi-agent version.\n"
			if out.String() != want {
				t.Errorf("stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", out.String(), want)
			}
			cfg := v2ConfigJSON(t)
			if cfg["multiAgentMode"] != modeArg {
				t.Errorf("multiAgentMode = %v, want %s", cfg["multiAgentMode"], modeArg)
			}
			if modeArg == "v1" {
				// v1 forces the global override off through the fake shim.
				if got := v2Toml(t); got != "[features.multi_agent_v2]\nenabled = false\n" {
					t.Errorf("config.toml after mode v1 = %q", got)
				}
			}
		})
	}
}

func TestV2KeepNativeVerbGolden(t *testing.T) {
	// A config with mode v2 + a live global override: keep-native-v1 on must
	// first drop the override (spawns the fake disable shim) then pin.
	cfgWithV2 := `{"clientIntegrations":{"codex":false},"multiAgentMode":"v2","providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture"}`
	t.Run("keep-native-v1 on drops a live v2 override then pins", func(t *testing.T) {
		v2Env(t, cfgWithV2, "[features.multi_agent_v2]\nenabled = true\n")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "keep-native-v1", "on")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		want := "keep_native_chatgpt_on_v1: ON — ChatGPT-native rows stay v1 when mode is v2 (new sessions).\n"
		if out.String() != want {
			t.Errorf("stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", out.String(), want)
		}
		if got := v2Toml(t); got != "[features.multi_agent_v2]\nenabled = false\n" {
			t.Errorf("config.toml = %q, want override dropped", got)
		}
		if v2ConfigJSON(t)["keepNativeChatGptOnV1"] != true {
			t.Errorf("keepNativeChatGptOnV1 not pinned")
		}
	})
	t.Run("keep-native-v1 off unpins and prints the follow line", func(t *testing.T) {
		v2Env(t, `{"clientIntegrations":{"codex":false},"keepNativeChatGptOnV1":true,"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture"}`, "")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "keep-native-v1", "off")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		want := "keep_native_chatgpt_on_v1: OFF — ChatGPT-native rows follow v1/base/v2 (new sessions).\n"
		if out.String() != want {
			t.Errorf("stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", out.String(), want)
		}
		if _, ok := v2ConfigJSON(t)["keepNativeChatGptOnV1"]; ok {
			t.Errorf("keepNativeChatGptOnV1 key not removed")
		}
	})
	t.Run("keep-native-v1 already on reports resynced", func(t *testing.T) {
		v2Env(t, `{"clientIntegrations":{"codex":false},"keepNativeChatGptOnV1":true,"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture"}`, "")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "keep-native-v1", "on")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "keep_native_chatgpt_on_v1 already ON — catalog re-synced.\n"; out.String() != want {
			t.Errorf("stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", out.String(), want)
		}
	})
	bad := map[string]string{
		"maybe": "v2 keep-native-v1: expected on|off\n",
	}
	for val, wantErr := range bad {
		t.Run("keep-native-v1 bad value "+val, func(t *testing.T) {
			v2Env(t, v2BaseConfig, "")
			deps := v2Deps()
			var out, errOut bytes.Buffer
			deps.Stdout, deps.Stderr = &out, &errOut
			code := v2Run(&deps, &out, &errOut, "keep-native-v1", val)
			if code != ExitFailure {
				t.Fatalf("exit = %d", code)
			}
			if errOut.String() != wantErr {
				t.Errorf("stderr = %q, want %q", errOut.String(), wantErr)
			}
		})
	}
}

func TestV2ThreadsAndModeHintGolden(t *testing.T) {
	t.Run("threads while v2 enabled inserts the limit before enabled", func(t *testing.T) {
		v2Env(t, v2BaseConfig, "[features.multi_agent_v2]\nenabled = true\n")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "threads", "12")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "max_threads = 12 (v2) — applies to new sessions.\n"; out.String() != want {
			t.Errorf("stdout = %q, want %q", out.String(), want)
		}
		// Dedicated-table editors insert at header+1 (before an existing
		// `enabled` line), exactly like the TS engine (oracle-verified).
		if got := v2Toml(t); got != "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 12\nenabled = true\n" {
			t.Errorf("config.toml = %q", got)
		}
	})
	t.Run("threads while v2 disabled writes the v1 agents limit", func(t *testing.T) {
		v2Env(t, v2BaseConfig, "")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "threads", "8")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "max_threads = 8 (v1) — applies to new sessions.\n"; out.String() != want {
			t.Errorf("stdout = %q, want %q", out.String(), want)
		}
		// Creating [agents] on an empty file keeps the trailing empty split
		// line, so the table starts one blank line in and has NO trailing
		// newline (TS oracle xxd: 0x0a-prefixed, size 25, no 0x0a at end).
		if got := v2Toml(t); got != "\n[agents]\nmax_threads = 8" {
			t.Errorf("config.toml = %q", got)
		}
	})
	t.Run("threads no-op reports already", func(t *testing.T) {
		v2Env(t, v2BaseConfig, "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 3\n")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "threads", "3")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "max_threads already 3 — nothing to do.\n"; out.String() != want {
			t.Errorf("stdout = %q, want %q", out.String(), want)
		}
	})
	t.Run("mode-hint set and clear roundtrip", func(t *testing.T) {
		v2Env(t, v2BaseConfig, "")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		if code := v2Run(&deps, &out, &errOut, "mode-hint", "reply in klingon"); code != ExitOK {
			t.Fatalf("set exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "multi_agent_mode_hint_text set (new sessions).\n"; out.String() != want {
			t.Errorf("set stdout = %q, want %q", out.String(), want)
		}
		// A fresh empty file gains the dedicated table with no leading blank
		// line (oracle-verified against the TS engine).
		if got := v2Toml(t); got != "[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"reply in klingon\"\n" {
			t.Errorf("config.toml after set = %q", got)
		}
		if code := v2Run(&deps, &out, &errOut, "mode-hint", "--clear"); code != ExitOK {
			t.Fatalf("clear exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "multi_agent_mode_hint_text cleared — effort-derived policy resumes (new sessions).\n"; out.String() != want {
			t.Errorf("clear stdout = %q, want %q", out.String(), want)
		}
		// Clearing the only key leaves the (now empty) dedicated table header
		// behind, exactly like the TS editor.
		if got := v2Toml(t); got != "[features.multi_agent_v2]\n" {
			t.Errorf("config.toml after clear = %q", got)
		}
	})
	t.Run("mode-hint already set reports nothing to do", func(t *testing.T) {
		v2Env(t, v2BaseConfig, "[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"same\"\n")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut, "mode-hint", "same")
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		if want := "multi_agent_mode_hint_text already set — nothing to do.\n"; out.String() != want {
			t.Errorf("stdout = %q, want %q", out.String(), want)
		}
	})
}

func TestV2WriteVerbErrorsGolden(t *testing.T) {
	errorTexts := []struct {
		args []string
		want string
	}{
		{args: []string{"bogus"}, want: "v2: unknown verb 'bogus' (expected status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>)\n"},
		{args: []string{"mode-hint"}, want: "v2 mode-hint: pass the hint text, or --clear to unset it.\n"},
		{args: []string{"mode-hint", "  "}, want: "v2 mode-hint: pass the hint text, or --clear to unset it.\n"},
		{args: []string{"threads"}, want: "v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)\n"},
		{args: []string{"threads", "abc"}, want: "v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)\n"},
		{args: []string{"threads", "0"}, want: "v2 threads: pass an integer >= 1 (features.multi_agent_v2.max_concurrent_threads_per_session)\n"},
		{args: []string{"mode"}, want: "v2 mode: expected v1|default|v2\n"},
		{args: []string{"mode", "v3"}, want: "v2 mode: expected v1|default|v2\n"},
		{args: []string{"mode", "  "}, want: "v2 mode: expected v1|default|v2\n"},
		{args: []string{"keep-native-v1", "maybe"}, want: "v2 keep-native-v1: expected on|off\n"},
	}
	for _, tc := range errorTexts {
		t.Run(fmt.Sprintf("%v", tc.args), func(t *testing.T) {
			v2Env(t, v2BaseConfig, "")
			deps := v2Deps()
			var out, errOut bytes.Buffer
			deps.Stdout, deps.Stderr = &out, &errOut
			code := v2Run(&deps, &out, &errOut, tc.args...)
			if code != ExitFailure {
				t.Fatalf("%v exit = %d (want 1)", tc.args, code)
			}
			if errOut.String() != tc.want {
				t.Errorf("%v stderr:\n--- got ---\n%s\n--- want ---\n%s", tc.args, errOut.String(), tc.want)
			}
			if out.Len() != 0 {
				t.Errorf("%v stdout not empty: %q", tc.args, out.String())
			}
		})
	}
	// Bare `v2` (no verb) and explicit `status` share the v2a read surface.
	t.Run("bare v2 renders status", func(t *testing.T) {
		v2Env(t, v2BaseConfig, "")
		deps := v2Deps()
		var out, errOut bytes.Buffer
		deps.Stdout, deps.Stderr = &out, &errOut
		code := v2Run(&deps, &out, &errOut)
		if code != ExitOK {
			t.Fatalf("exit = %d, stderr = %q", code, errOut.String())
		}
		if got, want := out.String(), runV2StatusGolden(t, ""); got != want {
			t.Errorf("bare v2 stdout mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
		}
	})
}

// runV2StatusGolden recomputes the expected status block for a fixture so the
// write-verb tests do not duplicate the v2a golden literals.
func runV2StatusGolden(t *testing.T, extra string) string {
	t.Helper()
	cfg := map[string]any{}
	if err := json.Unmarshal([]byte(v2BaseConfig), &cfg); err != nil {
		t.Fatal(err)
	}
	if extra != "" {
		extraDoc := map[string]any{}
		if err := json.Unmarshal([]byte(extra), &extraDoc); err != nil {
			t.Fatal(err)
		}
		for k, v := range extraDoc {
			cfg[k] = v
		}
	}
	home := t.TempDir()
	raw, _ := json.Marshal(cfg)
	codexHome := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	var out, errOut bytes.Buffer
	code := runV2Status(nil, Deps{Stdout: &out, Stderr: &errOut})
	if code != ExitOK {
		t.Fatalf("status exit = %d, stderr = %q", code, errOut.String())
	}
	return out.String()
}
