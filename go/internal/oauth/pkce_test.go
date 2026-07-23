package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"testing"
)

func TestGeneratePKCEUsesS256AndBase64URL(t *testing.T) {
	t.Parallel()
	pkce, err := GeneratePKCE()
	if err != nil {
		t.Fatalf("GeneratePKCE() error = %v", err)
	}
	if len(pkce.Verifier) != 43 {
		t.Fatalf("verifier length = %d, want 43", len(pkce.Verifier))
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(pkce.Verifier) {
		t.Fatalf("verifier is not unpadded base64url: %q", pkce.Verifier)
	}
	digest := sha256.Sum256([]byte(pkce.Verifier))
	want := base64.RawURLEncoding.EncodeToString(digest[:])
	if pkce.Challenge != want {
		t.Fatalf("challenge = %q, want %q", pkce.Challenge, want)
	}
}

func TestGeneratePKCEIsRandom(t *testing.T) {
	t.Parallel()
	first, err := GeneratePKCE()
	if err != nil {
		t.Fatal(err)
	}
	second, err := GeneratePKCE()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two PKCE generations returned the same verifier and challenge")
	}
}
