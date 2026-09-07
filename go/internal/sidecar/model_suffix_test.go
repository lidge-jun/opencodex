package sidecar

import (
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

func TestStripBracketedModelSuffix(t *testing.T) {
	long := "model" + strings.Repeat("[", 100_000) + "x"
	validLong := "model[" + strings.Repeat("x", 100_000) + "]"
	unmatchedClosing := "model" + strings.Repeat("x", 100_000) + "]"
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"trailing marker", "glm-5.2[1m]", "glm-5.2"},
		{"bare id", "glm-5.2", "glm-5.2"},
		{"trailing unicode whitespace after suffix", "glm-5.2[1m] ", "glm-5.2"},
		{"trailing whitespace without suffix", "glm-5.2 \t\r\n", "glm-5.2 \t\r\n"},
		{"interior group", "a[b]c", "a[b]c"},
		{"empty group", "model[]", "model"},
		{"only final group", "model[first][second]", "model[first]"},
		{"long malformed suffix", long, long},
		{"long valid suffix", validLong, "model"},
		{"long unmatched closing bracket", unmatchedClosing, unmatchedClosing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := StripBracketedModelSuffix(tc.in); got != tc.want {
				t.Fatalf("StripBracketedModelSuffix() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeOpenAIChatRequestModel(t *testing.T) {
	provider := func(raw string) *jsonwire.Value {
		value, err := jsonwire.Parse([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	cases := []struct {
		name    string
		config  string
		body    string
		want    string
		changed bool
	}{
		{
			name:    "flagged chat strips suffix",
			config:  `{"adapter":"openai-chat","modelSuffixBracketStrip":true}`,
			body:    `{"model":"glm-5.2[1m]","messages":[]}`,
			want:    `{"model":"glm-5.2","messages":[]}`,
			changed: true,
		},
		{
			name:   "unflagged chat preserves bytes",
			config: `{"adapter":"openai-chat"}`,
			body:   `{"model":"glm-5.2[1m]","messages":[]}`,
			want:   `{"model":"glm-5.2[1m]","messages":[]}`,
		},
		{
			name:   "other adapter preserves bytes",
			config: `{"adapter":"anthropic","modelSuffixBracketStrip":true}`,
			body:   `{"model":"glm-5.2[1m]","messages":[]}`,
			want:   `{"model":"glm-5.2[1m]","messages":[]}`,
		},
		{
			name:   "bare model preserves original formatting",
			config: `{"adapter":"openai-chat","modelSuffixBracketStrip":true}`,
			body:   `{"model":"glm-5.2","messages":[]}`,
			want:   `{"model":"glm-5.2","messages":[]}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, changed, err := NormalizeOpenAIChatRequestModel(provider(tc.config), []byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if changed != tc.changed || string(got) != tc.want {
				t.Fatalf("got %q changed=%v, want %q changed=%v", got, changed, tc.want, tc.changed)
			}
		})
	}
}
