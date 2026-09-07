package jsonwire_test

import (
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// TestEncodePrettyMatchesV8 pins EncodePretty against JSON.stringify(value,
// null, 2) as emitted by Node/V8 for the same parsed document: two-space
// indent, each object member and array element on its own line, ": " after
// object keys, inline empty containers, canonical re-encoded numbers, and
// unchanged string escaping.
func TestEncodePrettyMatchesV8(t *testing.T) {
	cases := map[string]string{
		`{"a":{"b":1,"c":[1,2,{"x":"y"}],"e":[]},"d":2,"n":1.0,"big":1e21}`:
			"{\n  \"a\": {\n    \"b\": 1,\n    \"c\": [\n      1,\n      2,\n      {\n        \"x\": \"y\"\n      }\n    ],\n    \"e\": []\n  },\n  \"d\": 2,\n  \"n\": 1,\n  \"big\": 1e+21\n}",
		`{"only":{}}`:
			"{\n  \"only\": {}\n}",
		`[[],{"z":null}]`:
			"[\n  [],\n  {\n    \"z\": null\n  }\n]",
		`{"s":"a\"b\\c\nd\u2028e"}`:
			"{\n  \"s\": \"a\\\"b\\\\c\\nd\u2028e\"\n}",
		`{"-0":-0.0,"x":-1.5e-7,"y":0.000001}`:
			"{\n  \"-0\": 0,\n  \"x\": -1.5e-7,\n  \"y\": 0.000001\n}",
	}
	for payload, want := range cases {
		value, err := jsonwire.Parse([]byte(payload))
		if err != nil {
			t.Fatalf("parse %q: %v", payload, err)
		}
		got, err := value.EncodePretty()
		if err != nil {
			t.Fatalf("encode %q: %v", payload, err)
		}
		if string(got) != want {
			t.Fatalf("pretty mismatch for %s\n got: %s\nwant: %s", payload, got, want)
		}
	}
}

// TestEncodePrettyArrayIndexOrdering confirms pretty output reuses the same
// array-index-first member ordering as compact Encode (V8 own-property order).
func TestEncodePrettyArrayIndexOrdering(t *testing.T) {
	payload := `{"b":1,"2":"two","a":3,"10":"ten"}`
	value, err := jsonwire.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	got, err := value.EncodePretty()
	if err != nil {
		t.Fatal(err)
	}
	compact, err := value.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "\"2\": \"two\"") || !strings.Contains(string(got), "\"10\": \"ten\"") {
		t.Fatalf("pretty output lost array-index ordering: %s", got)
	}
	if string(compact) != `{"2":"two","10":"ten","b":1,"a":3}` {
		t.Fatalf("compact reference drifted: %s", compact)
	}
}
