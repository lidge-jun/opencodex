package config

import (
	"strings"
	"testing"
)

// TestOrderedEchoPreservesKeyOrderAndCanonicalisesWhitespace is the byte-parity
// core: the TS handler returns JSON.stringify(config.customModels), which keeps
// each entry's FILE key order (zod passthrough does not reorder) and emits no
// whitespace. The fixture is pretty-printed with keys deliberately NOT in the
// schema's field order to prove the echo follows the file, not a struct.
func TestOrderedEchoPreservesKeyOrderAndCanonicalisesWhitespace(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{
  "port": 18080,
  "customModels": [
    {
      "zetaField": 1,
      "provider": "test",
      "modelId": "custom-a",
      "displayName": "Custom A",
      "contextWindow": 99999
    },
    { "provider": "anthropic", "modelId": "custom-b" }
  ]
}`)
	root, err := LoadOrderedFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	models := root.Find("customModels")
	if models == nil {
		t.Fatal("customModels not found in the ordered document")
	}
	raw, err := models.MarshalStringify()
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"zetaField":1,"provider":"test","modelId":"custom-a","displayName":"Custom A","contextWindow":99999},{"provider":"anthropic","modelId":"custom-b"}]`
	if string(raw) != want {
		t.Fatalf("echo = %s\nwant  %s", raw, want)
	}
}

// TestOrderedEchoMissingFileYieldsNullRoot mirrors Load's ENOENT default: an
// absent config file must not error the ordered loader either.
func TestOrderedEchoMissingFileYieldsNullRoot(t *testing.T) {
	root, err := LoadOrderedFromDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !root.IsNull() {
		t.Fatalf("expected a null root for a missing file, got %+v", root)
	}
	if found := root.Find("customModels"); found != nil {
		t.Fatal("Find on a null root must return nil")
	}
}

// TestOrderedEchoNullValueIsFindable mirrors the TS `config.customModels ?? []`
// nullish coalescing: a configured null is a present value that projects to [].
func TestOrderedEchoNullValueIsFindable(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{"customModels": null}`)
	root, err := LoadOrderedFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	models := root.Find("customModels")
	if models == nil || !models.IsNull() {
		t.Fatalf("customModels must be findable and null, got %+v", models)
	}
}

// TestOrderedEchoStringEscapingMatchesJSONStringify pins the escaping contract
// against JSON.stringify: <, >, &, U+2028 and U+2029 are all emitted literally
// (no HTML escaping, no \u2028), while the five named control characters get
// shortcuts and other code points below U+0020 get lowercase \u00xx escapes.
func TestOrderedEchoStringEscapingMatchesJSONStringify(t *testing.T) {
	dir := t.TempDir()
	// The \u00xx and \u2028 file escapes exercise the decoder -> re-encoder
	// round trip; the literal control byte 0x01 exercises direct echo.
	writeFixture(t, dir, "{\"customModels\": [{\"modelId\": \"a<b>&c\\u2028d\\u2029e\\u0001f\\t\", \"provider\": \"x\"}]}")
	root, err := LoadOrderedFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := root.Find("customModels").MarshalStringify()
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != expectedEcho() {
		t.Fatalf("escape echo = %q\nwant          %q", raw, expectedEcho())
	}
}

// expectedEcho is the exact JSON.stringify output for the fixture above,
// verified against Bun: <, >, &, U+2028 and U+2029 literal; 0x01 as \u0001;
// the tab as \t.
func expectedEcho() string {
	return `[{"modelId":"a<b>&c` + "\u2028" + `d` + "\u2029" + `e\u0001f\t","provider":"x"}]`
}

// TestOrderedEchoNumberLiteralStaysVerbatim documents the number-literal rule:
// a TypeScript-written file already carries JSON.stringify-canonical numbers so
// raw echo equals JS output. A hand-edited non-canonical literal ("1.0") is
// echoed as-is by the Go side where JS would emit 1 — the package's documented
// non-canonical-config divergence, asserted here so the behavior is pinned.
func TestOrderedEchoNumberLiteralStaysVerbatim(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{"customModels": [{"modelId": "a", "contextWindow": 1.0}]}`)
	root, err := LoadOrderedFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := root.Find("customModels").MarshalStringify()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"contextWindow":1.0`) {
		t.Fatalf("non-canonical literal must be echoed verbatim, got %s", raw)
	}
}

// TestOrderedEchoNestedStructures exercises arrays of objects and nested keys,
// which is the shape a future DTO projection (provider entries) will need.
func TestOrderedEchoNestedStructures(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{"a": {"b": [1, true, null, {"z": 1, "y": 2}]}, "c": "tail"}`)
	root, err := LoadOrderedFromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := root.MarshalStringify()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"a":{"b":[1,true,null,{"z":1,"y":2}]},"c":"tail"}`
	if string(raw) != want {
		t.Fatalf("nested echo = %s\nwant          %s", raw, want)
	}
}

// TestOrderedEchoMalformedFileErrors mirrors LoadFromPath: the ordered loader
// must report a malformed file instead of silently echoing a partial value.
func TestOrderedEchoMalformedFileErrors(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, `{"customModels": [`)
	if _, err := LoadOrderedFromDir(dir); err == nil {
		t.Fatal("expected a decode error for a truncated file")
	}
}
