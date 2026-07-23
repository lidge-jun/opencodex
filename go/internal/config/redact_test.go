package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestRedactKnownPatterns(t *testing.T) {
	input := `Authorization: Bearer abcdefghijklmnop apiKey=secret-value token sk-123456789 github_pat_abcdefghijklmnopqrstuvwxyz`
	got := RedactString(input)
	for _, secret := range []string{"abcdefghijklmnop", "secret-value", "sk-123456789", "github_pat_abcdefghijklmnopqrstuvwxyz"} {
		if strings.Contains(got, secret) {
			t.Fatalf("RedactString() leaked %q in %q", secret, got)
		}
	}
}

func TestRedactMap(t *testing.T) {
	input := map[string]any{
		"password": "secret",
		"nested":   map[string]any{"authorization": "Bearer abcdefghijk", "safe": "hello"},
	}
	want := map[string]any{
		"password": RedactedSecret,
		"nested":   map[string]any{"authorization": RedactedSecret, "safe": "hello"},
	}
	if got := RedactMap(input); !reflect.DeepEqual(got, want) {
		t.Fatalf("RedactMap() = %#v, want %#v", got, want)
	}
}
