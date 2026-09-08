package ocxcli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestV2StatusGolden pins `ocx v2 status` output against the TypeScript CLI
// (issue #56 slice v2a). Each case runs with an isolated OPENCODEX_HOME +
// CODEX_HOME; the expected text is the TS CLI's byte output for the same
// fixture (verified by the parity rows in tests/go-cli-parity.test.ts).
func TestV2StatusGolden(t *testing.T) {
	const baseConfig = `{"providers":{"fixture":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"secret-key","defaultModel":"fixture-model","models":["fixture-model"],"contextWindow":128000}},"defaultProvider":"fixture"}`
	unset := "multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
		"keep_native_chatgpt_on_v1: OFF\n" +
		"max_threads: (unset — codex default)\n" +
		"agents.enabled: (unset — upstream default true)\n"
	cases := []struct {
		name    string
		cfgJSON string // extra top-level config.json keys merged over the base
		toml    string // CODEX_HOME/config.toml content
		want    string // full expected stdout
	}{
		{
			name: "empty homes",
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" +
				unset +
				"agents.max_depth: (unset — upstream default 1)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "v2 off default",
			toml: "[features]\n",
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" + unset +
				"agents.max_depth: (unset — upstream default 1)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "v2 on dedicated table",
			toml: "[features.multi_agent_v2]\nenabled = true\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "v2 on with v2 threads and legacy warning",
			toml: "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 4\n\n[agents]\nmax_threads = 8\n",
			want: "multi_agent_v2: ON — global V2 override active\n" +
				"multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
				"keep_native_chatgpt_on_v1: OFF\n" +
				"max_threads: 4\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n" +
				"WARNING: [agents] max_threads is set — codex refuses to start while multi_agent_v2 is enabled. Remove it from config.toml (concurrency lives in features.multi_agent_v2.max_concurrent_threads_per_session).\n",
		},
		{
			name: "v2 off legacy threads",
			toml: "[agents]\nmax_threads = 8\n",
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" +
				"multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
				"keep_native_chatgpt_on_v1: OFF\n" +
				"max_threads: 8\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name:    "v2 on mode v2 keep-native conflict",
			cfgJSON: `{"multiAgentMode":"v2","keepNativeChatGptOnV1":true}`,
			toml:    "[features.multi_agent_v2]\nenabled = true\n",
			want: "multi_agent_v2: ON — global V2 override active\n" +
				"multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2\n" +
				"keep_native_chatgpt_on_v1: CONFLICT — global multi_agent_v2 overrides the native v1 catalog pin; run 'ocx v2 keep-native-v1 on' to reconcile\n" +
				"max_threads: (unset — codex default)\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name:    "v2 off mode v2 keep-native on",
			cfgJSON: `{"multiAgentMode":"v2","keepNativeChatGptOnV1":true}`,
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" +
				"multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2\n" +
				"keep_native_chatgpt_on_v1: ON — global V2 override is off; ChatGPT-native rows use v1 and routed rows use v2 when mode is v2\n" +
				"max_threads: (unset — codex default)\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "string fields",
			toml: "[features.multi_agent_v2]\nenabled = true\nsubagent_developer_instructions = \"reply in haiku\"\nmulti_agent_mode_hint_text = 'hint value'\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: \"reply in haiku\"\n" +
				"multi_agent_mode_hint_text: \"hint value\"\n",
		},
		{
			name: "v2 on inline features table",
			toml: "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 3 }\n",
			want: "multi_agent_v2: ON — global V2 override active\n" +
				"multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
				"keep_native_chatgpt_on_v1: OFF\n" +
				"max_threads: 3\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			codexHome := t.TempDir()
			configPath := filepath.Join(home, "config.json")
			doc := map[string]any{}
			if err := json.Unmarshal([]byte(baseConfig), &doc); err != nil {
				t.Fatal(err)
			}
			if tc.cfgJSON != "" {
				extra := map[string]any{}
				if err := json.Unmarshal([]byte(tc.cfgJSON), &extra); err != nil {
					t.Fatal(err)
				}
				for k, v := range extra {
					doc[k] = v
				}
			}
			raw, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(configPath, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			if tc.toml != "" {
				if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(tc.toml), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("OPENCODEX_HOME", home)
			t.Setenv("CODEX_HOME", codexHome)

			var out, errOut bytes.Buffer
			code := runV2Status(nil, Deps{Stdout: &out, Stderr: &errOut})
			if code != ExitOK {
				t.Fatalf("runV2Status exit = %d, stderr = %q", code, errOut.String())
			}
			if out.String() != tc.want {
				t.Errorf("v2 status output mismatch:\n--- got ---\n%s\n--- want ---\n%s", out.String(), tc.want)
			}
		})
	}
}

// TestV2StatusOwnership gates the carve-out: `v2 status` dispatches natively,
// the bare surface and every write verb stay with the TypeScript owner.
func TestV2StatusOwnership(t *testing.T) {
	if owner, known := OwnershipFor([]string{"v2", "status"}); !known || owner != GoOwned {
		t.Fatalf("v2 status ownership = %q, %t; want GoOwned", owner, known)
	}
	for _, verb := range []string{"on", "off", "mode", "threads", "keep-native-v1", "mode-hint", "bogus"} {
		argv := []string{"v2"}
		if verb != "" {
			argv = append(argv, verb)
		}
		if owner, known := OwnershipFor(argv); !known || owner != TypeScriptOwned {
			t.Fatalf("%v ownership = %q, %t; want TypeScriptOwned", argv, owner, known)
		}
	}
}
