package google

import (
	"reflect"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAntigravitySessionAndSignatureValidation(t *testing.T) {
	req := &types.NormalizedRequest{Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: rawJSON("same")}}}}
	if first, second := AntigravitySessionID(req), AntigravitySessionID(req); first != second || first[0] != '-' {
		t.Fatalf("unstable session ids: %q %q", first, second)
	}
	if IsLikelyRealThoughtSignature("fc_1234567890abcdef") || !IsLikelyRealThoughtSignature("sig-1234567890abcdef") {
		t.Fatal("thought signature classifier mismatch")
	}
}

func TestReplayStoreAccumulatesCanonicalFunctionCallSignatures(t *testing.T) {
	store := NewReplayStore()
	store.Observe("gemini-3-pro", "-1", []any{map[string]any{
		"functionCall":     map[string]any{"name": "edit", "args": map[string]any{"outer": map[string]any{"x": 1, "y": 2}}},
		"thoughtSignature": "sig-aaaaaaaaaaaaaaaa",
	}})
	store.Observe("gemini-3-pro", "-1", []any{map[string]any{
		"functionCall":  map[string]any{"name": "run", "args": map[string]any{"cmd": "ls"}},
		"extra_content": map[string]any{"google": map[string]any{"thought_signature": "sig-bbbbbbbbbbbbbbbb"}},
	}})
	contents := []any{
		map[string]any{"role": "model", "parts": []any{
			map[string]any{"functionCall": map[string]any{"name": "edit", "args": map[string]any{"outer": map[string]any{"y": 2, "x": 1}}}},
		}},
		map[string]any{"role": "model", "parts": []any{
			map[string]any{"functionCall": map[string]any{"name": "run", "args": map[string]any{"cmd": "ls"}}},
		}},
	}
	store.Apply("gemini-3-pro", "-1", contents)
	first := contents[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["thoughtSignature"]
	second := contents[1].(map[string]any)["parts"].([]any)[0].(map[string]any)["thoughtSignature"]
	if !reflect.DeepEqual([]any{first, second}, []any{"sig-aaaaaaaaaaaaaaaa", "sig-bbbbbbbbbbbbbbbb"}) {
		t.Fatalf("replayed signatures = %#v %#v", first, second)
	}
	store.Clear("gemini-3-pro", "-1")
	clean := []any{map[string]any{"role": "model", "parts": []any{
		map[string]any{"functionCall": map[string]any{"name": "run", "args": map[string]any{"cmd": "ls"}}},
	}}}
	store.Apply("gemini-3-pro", "-1", clean)
	if _, exists := clean[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["thoughtSignature"]; exists {
		t.Fatal("clear did not remove replay entry")
	}
}

func TestSanitizeAntigravityClaudeSignatures(t *testing.T) {
	contents := []any{
		map[string]any{"role": "model", "parts": []any{map[string]any{"thought": true, "text": "drop"}, map[string]any{"thought": true, "thoughtSignature": "sig-1234567890abcdef"}}},
		map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hi", "thoughtSignature": "sig-1234567890abcdef"}}},
	}
	SanitizeAntigravityClaudeSignatures(contents)
	modelParts := contents[0].(map[string]any)["parts"].([]any)
	if len(modelParts) != 1 {
		t.Fatalf("model parts = %#v", modelParts)
	}
	userPart := contents[1].(map[string]any)["parts"].([]any)[0].(map[string]any)
	if _, exists := userPart["thoughtSignature"]; exists {
		t.Fatal("user signature was not stripped")
	}
}
