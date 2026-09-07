package sidecar

import (
	"strings"
	"unicode"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// StripBracketedModelSuffix mirrors the TypeScript openai-chat adapter. It
// removes one trailing bracket group from a model id when the provider opts
// into the compatibility behavior. Whitespace is considered only while
// locating a terminal suffix; if no suffix exists, the original string is
// returned unchanged.
func StripBracketedModelSuffix(modelID string) string {
	trimmed := strings.TrimRightFunc(modelID, unicode.IsSpace)
	suffixEnd := len(trimmed)
	if suffixEnd == 0 || modelID[suffixEnd-1] != ']' {
		return modelID
	}

	suffixStart := -1
	for i := suffixEnd - 2; i >= 0 && modelID[i] != ']'; i-- {
		if modelID[i] == '[' {
			suffixStart = i
		}
	}
	if suffixStart < 0 {
		return modelID
	}
	return modelID[:suffixStart]
}

// NormalizeOpenAIChatRequestModel applies the provider-scoped wire-model
// normalization used by the openai-chat adapter. The input is a complete JSON
// request body; when the flag is absent or false, or the body has no string
// model field, the original bytes are returned untouched. A changed body is
// encoded with the same ordered JSON representation used by the relay.
func NormalizeOpenAIChatRequestModel(provider *jsonwire.Value, raw []byte) ([]byte, bool, error) {
	if !openAIChatBracketStripEnabled(provider) {
		return raw, false, nil
	}
	root, err := jsonwire.Parse(raw)
	if err != nil {
		return nil, false, err
	}
	if root == nil || root.Kind() != jsonwire.Object {
		return raw, false, nil
	}
	model := root.Find("model")
	if model == nil || model.Kind() != jsonwire.String {
		return raw, false, nil
	}
	wireModel := StripBracketedModelSuffix(model.String())
	if wireModel == model.String() {
		return raw, false, nil
	}
	root.Set("model", jsonwire.StringValue(wireModel))
	encoded, err := root.Encode()
	if err != nil {
		return nil, false, err
	}
	return encoded, true, nil
}

func openAIChatBracketStripEnabled(provider *jsonwire.Value) bool {
	if provider == nil || provider.Kind() != jsonwire.Object {
		return false
	}
	adapter, ok := stringMember(provider, "adapter")
	if !ok || adapter != "openai-chat" {
		return false
	}
	enabled, ok := boolMember(provider, "modelSuffixBracketStrip")
	return ok && enabled
}
