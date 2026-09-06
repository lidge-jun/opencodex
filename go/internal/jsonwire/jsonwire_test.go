package jsonwire

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// numberCorpusRow is one literal/expected pair from the committed Bun corpus
// (.tmp/gen-number-corpus.mjs): the literal is JSON text, the expected column
// is JSON.stringify(Number(literal)) as V8 emits it.
func numberCorpusRows(t *testing.T) [][2]string {
	t.Helper()
	file, err := os.Open(filepath.Join("testdata", "v8-numbers.tsv"))
	if err != nil {
		t.Fatalf("open corpus: %v", err)
	}
	defer file.Close()
	var rows [][2]string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 2 {
			t.Fatalf("malformed corpus row %q", scanner.Text())
		}
		rows = append(rows, [2]string{fields[0], fields[1]})
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan corpus: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("corpus is empty")
	}
	return rows
}

// TestFormatV8NumberAgainstBunCorpus pins number formatting to V8's
// JSON.stringify for edge literals and random finite doubles.
func TestFormatV8NumberAgainstBunCorpus(t *testing.T) {
	for _, row := range numberCorpusRows(t) {
		literal, want := row[0], row[1]
		f, err := strconv.ParseFloat(literal, 64)
		if err != nil {
			t.Fatalf("corpus literal %q does not parse: %v", literal, err)
		}
		if got := FormatV8Number(f); got != want {
			t.Errorf("FormatV8Number(parse(%s)) = %q, want %q", literal, got, want)
		}
	}
}

func quoted(s string) string { return "\"" + s + "\"" }

// TestEncodeStringMatchesV8Escaping: control characters are escaped, U+2028 and
// U+2029 are emitted literally (encoding/json would escape them), and HTML
// characters are not escaped.
func TestEncodeStringMatchesV8Escaping(t *testing.T) {
	lsep := "\u2028"
	psep := "\u2029"
	cases := []struct {
		input string
		want  string
	}{
		{"plain", quoted("plain")},
		{"quote\\backslash", quoted("quote\\\\backslash")},
		{"tab:\tnewline:\ncr:\r", quoted("tab:\\tnewline:\\ncr:\\r")},
		{"control:\x01", quoted("control:\\u0001")},
		{"u2028:" + lsep + "u2029:" + psep, quoted("u2028:" + lsep + "u2029:" + psep)},
		{"html:<>&", quoted("html:<>&")},
		{"\u0000", quoted("\\u0000")},
		{"formfeed:\f", quoted("formfeed:\\f")},
		{"backspace:\b", quoted("backspace:\\b")},
	}
	for _, c := range cases {
		got, err := EncodeString(c.input)
		if err != nil {
			t.Fatalf("EncodeString(%q): %v", c.input, err)
		}
		if string(got) != c.want {
			t.Errorf("EncodeString(%q) = %s, want %s", c.input, got, c.want)
		}
	}
}

// TestOrderedRoundTripAndSetAppendsAtEnd: document order and spread semantics.
func TestOrderedRoundTripAndSetAppendsAtEnd(t *testing.T) {
	root, err := Parse([]byte(`{"b":1,"a":{"x":"y"},"c":[true,null]}`))
	if err != nil {
		t.Fatal(err)
	}
	root.Set("added", StringValue("tail"))
	root.Find("a").Set("x", NumberFrom(2))
	encoded, err := root.Encode()
	if err != nil {
		t.Fatal(err)
	}
	// b and a keep file order; new top-level key appends at the end; the
	// nested x keeps its position and 1.0-shaped literals canonicalise.
	if got, want := string(encoded), `{"b":1,"a":{"x":2},"c":[true,null],"added":"tail"}`; got != want {
		t.Fatalf("encode = %s, want %s", got, want)
	}
}

// TestEncodeCanonicalisesNumbers: a JSON literal is re-emitted the way
// JSON.stringify of the parsed Number would emit it.
func TestEncodeCanonicalisesNumbers(t *testing.T) {
	cases := map[string]string{
		`{"n":1.0}`:                 `{"n":1}`,
		`{"n":1e21}`:                `{"n":1e+21}`,
		`{"n":1e-7}`:                `{"n":1e-7}`,
		`{"n":0.30000000000000004}`: `{"n":0.30000000000000004}`,
		`{"n":9007199254740993}`:    `{"n":9007199254740992}`,
	}
	for input, want := range cases {
		root, err := Parse([]byte(input))
		if err != nil {
			t.Fatalf("parse %s: %v", input, err)
		}
		encoded, err := root.Encode()
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != want {
			t.Errorf("encode(%s) = %s, want %s", input, encoded, want)
		}
	}
}
