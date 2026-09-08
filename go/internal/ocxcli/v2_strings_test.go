package ocxcli

// v2_strings_test.go — byte-level golden tests for the mode-hint / string
// field writer (issue #56, slice v2b). Expected outputs are the TypeScript
// setV2StringField results for the identical inputs (generated with
// /tmp/v2edit_oracle.mjs).

import "testing"

func TestV2StringFieldGolden(t *testing.T) {
	cases := []struct {
		name    string
		toml    string
		value   *string
		want    string
		wantErr bool
	}{
		{
			name:  "dedicated table insert",
			toml:  "[features.multi_agent_v2]\nenabled = true\n",
			value: strPtr("ultra, focused"),
			want:  "[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"ultra, focused\"\nenabled = true\n",
		},
		{
			name:  "inline append",
			toml:  "[features]\nmulti_agent_v2 = { enabled = true }\n",
			value: strPtr("hint #x"),
			want:  "[features]\nmulti_agent_v2 = { enabled = true, multi_agent_mode_hint_text = \"hint #x\" }\n",
		},
		{
			name:  "clear dedicated",
			toml:  "[features.multi_agent_v2]\nenabled = true\nmulti_agent_mode_hint_text = \"old\"\n",
			want:  "[features.multi_agent_v2]\nenabled = true\n",
		},
		{
			name:    "no existing config creates table",
			toml:    "[other]\nx = 1\n",
			value:   strPtr("hello"),
			want:    "[other]\nx = 1\n\n[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"hello\"\n",
			wantErr: false,
		},
		{
			name:    "multiline value refused",
			toml:    "[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"\"\"\nline\n\"\"\"\n",
			value:   strPtr("x"),
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := v2TestWrite(t, tc.toml)
			result := setCodexV2StringField("multi_agent_mode_hint_text", tc.value, path)
			if tc.wantErr {
				if result.ok {
					t.Fatalf("setCodexV2StringField = %+v; want refusal", result)
				}
				return
			}
			if !result.ok {
				t.Fatalf("setCodexV2StringField = %+v (err %q); want ok", result, result.err)
			}
			if got := readV2Test(path); got != tc.want {
				t.Errorf("output mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, tc.want)
			}
		})
	}
}

func strPtr(s string) *string { return &s }
