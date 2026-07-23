package platform

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadServiceTokenPrefersEnvironmentAndTrimsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(" file-token \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := LoadServiceToken("env-token", path)
	if err != nil || token != "env-token" {
		t.Fatalf("environment token: token=%q err=%v", token, err)
	}
	token, err = LoadServiceToken("", path)
	if err != nil || token != "file-token" {
		t.Fatalf("file token: token=%q err=%v", token, err)
	}
}

func TestLoadServiceTokenRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, make([]byte, MaxServiceTokenBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadServiceToken("", path); err == nil {
		t.Fatal("expected oversized token file rejection")
	}
}

func TestReplaceFromReaderVerifiesDigestBeforeReplacement(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "ocx")
	if err := os.WriteFile(destination, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	payload := []byte("new-binary")
	digest := sha256.Sum256(payload)
	if err := replaceFromReader(bytes.NewReader(payload), digest[:], destination); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(updated, payload) {
		t.Fatalf("replacement=%q", updated)
	}
	wrong := sha256.Sum256([]byte("different"))
	if err := replaceFromReader(bytes.NewReader([]byte("bad")), wrong[:], destination); err == nil {
		t.Fatal("expected digest mismatch")
	}
	unchanged, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(unchanged, payload) {
		t.Fatalf("digest failure changed destination: %q", unchanged)
	}
}

func TestOpenURLRejectsNonHTTPURL(t *testing.T) {
	if err := OpenURL("file:///tmp/secret"); err == nil {
		t.Fatal("expected URL scheme rejection")
	}
}
