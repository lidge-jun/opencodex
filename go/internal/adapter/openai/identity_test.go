package openai

import (
	"strings"
	"testing"
)

func TestNeutralizeIdentity(t *testing.T) {
	input := CodexGPT5IdentityLine + "\nKeep changes focused."
	got := NeutralizeIdentity(input)
	if strings.Contains(got, CodexGPT5IdentityLine) || !strings.Contains(got, NeutralIdentityLine) {
		t.Fatalf("identity was not neutralized: %q", got)
	}
	plain := "You are a provider-native coding assistant."
	if got := NeutralizeIdentity(plain); got != plain {
		t.Fatalf("unrelated identity changed: %q", got)
	}
}
