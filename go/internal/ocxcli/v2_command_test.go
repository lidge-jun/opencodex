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
		// Review-fix contract (247c9e490 follow-up): per-key reader shapes in
		// features.ts are NOT uniform — the `[agents]` readers went parse-first
		// (underscore separators visible) while getMaxConcurrentThreads and the
		// string-field scanner stayed line-based. These rows pin the mirrored
		// Go behavior; each expected text is the TS CLI's byte output.
		{
			name: "hash inside basic string is data not comment",
			toml: "[features.multi_agent_v2]\nenabled = true\nsubagent_developer_instructions = \"ping #duty\"\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: \"ping #duty\"\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "hash inside literal string is data not comment",
			toml: "[features.multi_agent_v2]\nenabled = true\nmulti_agent_mode_hint_text = 'hint #value'\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: \"hint #value\"\n",
		},
		{
			// TS scanTomlValueEnd ends a literal at the FIRST following quote —
			// no `''` folding — so `'it''s here'` reads as `it`. Mirrored.
			name: "literal apostrophe truncates at first quote",
			toml: "[features.multi_agent_v2]\nenabled = true\nmulti_agent_mode_hint_text = 'it''s here'\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: \"it\"\n",
		},
		{
			name: "hash inside inline table string field",
			toml: "[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 4, subagent_developer_instructions = \"inline #hint\" }\n",
			want: "multi_agent_v2: ON — global V2 override active\n" +
				"multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
				"keep_native_chatgpt_on_v1: OFF\n" +
				"max_threads: 4\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: \"inline #hint\"\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "dotted multi_agent_v2.enabled form",
			toml: "[features]\nmulti_agent_v2.enabled = true\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "underscore digits in parse-first agents.max_threads",
			toml: "[agents]\nmax_threads = 1_000\n",
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" +
				"multi_agent_mode: default — upstream model pins respected (sol/terra=v2, luna=v1, rest=codex flag)\n" +
				"keep_native_chatgpt_on_v1: OFF\n" +
				"max_threads: 1000\n" +
				"agents.enabled: (unset — upstream default true)\n" +
				"agents.max_depth: (unset — upstream default 1)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			// getAgentsMaxDepth is scanner-only in features.ts — underscores
			// invisible there — unlike parse-first getAgentsMaxThreads.
			name: "underscore digits in scanner-only agents.max_depth read as unset",
			toml: "[agents]\nmax_depth = 2_000\n",
			want: "multi_agent_v2: OFF — model catalog pins and defaults decide the surface\n" + unset +
				"agents.max_depth: (unset — upstream default 1)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "underscore digits in scanner-only concurrent limit read as unset",
			toml: "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 3_000\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: (unset — children inherit)\n" +
				"multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)\n",
		},
		{
			name: "U+ and u+ escapes decode",
			toml: "[features.multi_agent_v2]\nenabled = true\nsubagent_developer_instructions = \"\\U0001F600 hi — \\u4F60\\u597D\"\n",
			want: "multi_agent_v2: ON — global V2 override active\n" + unset +
				"agents.max_depth: (unset — upstream default 1) (V1-only — ignored while multi_agent_v2 is enabled)\n" +
				"subagent_developer_instructions: \"😀 hi — 你好\"\n" +
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

// TestV2StatusOwnership pins the whole-command flip (issue #56 slice v2b):
// every `v2` surface — the bare form, status, and the write verbs — resolves
// to GoOwned; the deferral ledger no longer lists a v2 entry.
func TestV2StatusOwnership(t *testing.T) {
	for _, argv := range [][]string{
		{"v2"},
		{"v2", "status"},
		{"v2", "on"},
		{"v2", "off"},
		{"v2", "mode", "v1"},
		{"v2", "threads", "4"},
		{"v2", "keep-native-v1", "on"},
		{"v2", "mode-hint", "hi"},
		{"v2", "bogus"},
	} {
		if owner, known := OwnershipFor(argv); !known || owner != GoOwned {
			t.Fatalf("%v ownership = %q, %t; want GoOwned", argv, owner, known)
		}
	}
	for _, d := range deferredSurfaces {
		if d.Name == "v2" {
			t.Fatalf("deferral ledger still lists v2: %+v", d)
		}
	}
}
