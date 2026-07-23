package registry

import "testing"

func TestSlugCodecExactKnownIDDecoding(t *testing.T) {
	known := []string{"moonshotai/kimi-k3-free", "plain-model"}
	if got := RoutedSlug("zenmux", known[0]); got != "zenmux/moonshotai-kimi-k3-free" {
		t.Fatalf("RoutedSlug() = %q", got)
	}
	if got := DecodeRoutedModelID("moonshotai-kimi-k3-free", known); got != known[0] {
		t.Fatalf("DecodeRoutedModelID(alias) = %q", got)
	}
	if got := DecodeRoutedModelID(known[0], known); got != known[0] {
		t.Fatalf("DecodeRoutedModelID(native) = %q", got)
	}
	if got := DecodeRoutedModelID("unknown-looking-id", known); got != "unknown-looking-id" {
		t.Fatalf("unknown alias changed to %q", got)
	}
}

func TestSlugCodecRefusesAmbiguousAlias(t *testing.T) {
	known := []string{"a/b-c", "a-b/c"}
	if got := DecodeRoutedModelID("a-b-c", known); got != "a-b-c" {
		t.Fatalf("ambiguous alias decoded to %q", got)
	}
	if !SlugsEquivalent("provider/a/b", "provider/a-b") {
		t.Fatal("raw and encoded slugs should be equivalent")
	}
}
