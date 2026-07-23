package openai

import "testing"

func TestParseDataURL(t *testing.T) {
	parsed, err := ParseDataURL("data:image/png;base64,aGVsbG8=")
	if err != nil {
		t.Fatal(err)
	}
	if parsed == nil || parsed.MediaType != "image/png" || parsed.Base64 != "aGVsbG8=" {
		t.Fatalf("unexpected parsed data URL: %#v", parsed)
	}

	remote, err := ParseDataURL("https://example.test/image.png")
	if err != nil || remote != nil {
		t.Fatalf("remote URL = %#v, %v; want nil, nil", remote, err)
	}
	if _, err := ParseDataURL("data:image/png;base64,not-base64!"); err == nil {
		t.Fatal("invalid base64 payload was accepted")
	}
}
