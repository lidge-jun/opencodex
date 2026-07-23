package registry

import "testing"

func TestRegistryContainsAllBuiltInProviders(t *testing.T) {
	if got := len(Providers); got != 58 {
		t.Fatalf("provider count = %d, want 58", got)
	}
	reg := New()
	openrouter, ok := reg.Lookup("openrouter")
	if !ok {
		t.Fatal("openrouter missing")
	}
	if openrouter.Adapter != "openai-chat" || openrouter.BaseURL != "https://openrouter.ai/api/v1" || openrouter.AuthKind != AuthKey {
		t.Fatalf("unexpected openrouter entry: %#v", openrouter)
	}
	if _, ok := reg.Lookup("does-not-exist"); ok {
		t.Fatal("unknown provider unexpectedly resolved")
	}
}

func TestRegistryLookupReturnsDefensiveCopy(t *testing.T) {
	reg := New()
	entry, _ := reg.Lookup("zenmux")
	entry.Models[0].ID = "mutated"
	again, _ := reg.Lookup("zenmux")
	if again.Models[0].ID != "moonshotai/kimi-k3-free" {
		t.Fatalf("registry state was mutated: %#v", again.Models)
	}
}

func TestRegistryResolveModelDecodesKnownAlias(t *testing.T) {
	reg := New()
	resolved, err := reg.ResolveModel("zenmux/moonshotai-kimi-k3-free")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Provider != "zenmux" || resolved.Model != "moonshotai/kimi-k3-free" {
		t.Fatalf("resolved = %#v", resolved)
	}
	bare, err := reg.ResolveModel("gpt-5.6-sol")
	if err != nil {
		t.Fatal(err)
	}
	if bare.Provider != "openai" || bare.Model != "gpt-5.6-sol" {
		t.Fatalf("bare resolved = %#v", bare)
	}
}
