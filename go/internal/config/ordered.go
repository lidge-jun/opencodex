package config

// Ordered JSON support for config echo routes (ticket #17).
//
// The TypeScript runtime stores the config it parsed and emits it again with
// JSON.stringify when a route body is the config value itself (e.g. GET
// /api/custom-models returns `config.customModels ?? []`). JSON.stringify
// preserves object key insertion order — which for a parsed config file is the
// FILE's key order — and canonicalises whitespace. encoding/json's map-based
// decoding discards key order, so a faithful echo needs a value tree that keeps
// objects ordered. That order is exactly what the /api/config DTO projection
// will also need when it is ported (provider entries keep their file order), so
// this is the shared foundation, not a one-route hack.
//
// Numbers are kept as their raw JSON literal (json.RawMessage). A config file
// written by the TypeScript runtime already contains JSON.stringify-canonical
// numbers, so raw echo equals JavaScript output; only a hand-edited file with a
// non-canonical literal (e.g. "1.0" where JavaScript would emit 1) diverges,
// which is the same class of documented non-canonical-config caveat the
// package already carries.

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
)

// OrderedValue is one JSON value with object keys in document order. Only the
// operations the config echo routes need are exported: Find (key lookup),
// IsNull, and MarshalStringify (JSON.stringify-compatible bytes).
type OrderedValue struct {
	kind orderedKind
	obj  []orderedMember // kind == orderedObject, keyed in file order
	arr  []*OrderedValue // kind == orderedArray
	str  string          // kind == orderedString
	num  json.RawMessage // kind == orderedNumber, raw literal
	b    bool            // kind == orderedBool
}

type orderedKind int

const (
	orderedNull orderedKind = iota
	orderedObject
	orderedArray
	orderedString
	orderedNumber
	orderedBool
)

type orderedMember struct {
	key string
	val *OrderedValue
}

// OrderedEntry is one document-order object member. Projection routes use it
// when TypeScript's Object.entries order is part of their wire contract.
type OrderedEntry struct {
	Key   string
	Value *OrderedValue
	index uint32
}

// LoadOrdered reads and decodes config.json into an ordered value tree (the
// root object). A missing file yields a null root without error, mirroring
// Load's ENOENT default; a malformed file yields the decode error.
func LoadOrdered() (*OrderedValue, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}
	return LoadOrderedFromPath(path)
}

// LoadOrderedFromDir is LoadOrdered with an explicit config directory.
func LoadOrderedFromDir(dir string) (*OrderedValue, error) {
	return LoadOrderedFromPath(filepath.Join(dir, "config.json"))
}

// LoadOrderedFromPath is the raw ordered loader; the path comes from Path() or
// LoadOrderedFromDir.
func LoadOrderedFromPath(path string) (*OrderedValue, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &OrderedValue{kind: orderedNull}, nil
		}
		return nil, err
	}
	defer file.Close()
	return decodeOrdered(file)
}

// decodeOrdered decodes a whole JSON document into an ordered value tree.
func decodeOrdered(reader io.Reader) (*OrderedValue, error) {
	decoder := json.NewDecoder(reader)
	decoder.UseNumber()
	value, err := decodeOrderedNext(decoder)
	if err != nil {
		return nil, err
	}
	// A second value in the stream means the file is not a single JSON
	// document; the TS side would reject that too.
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, errors.New("config.json contains more than one JSON value")
		}
		return nil, err
	}
	return value, nil
}

// decodeOrderedNext recurses one JSON value from the token stream.
func decodeOrderedNext(decoder *json.Decoder) (*OrderedValue, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	return decodeOrderedValue(decoder, token)
}

func decodeOrderedValue(decoder *json.Decoder, token json.Token) (*OrderedValue, error) {
	switch typed := token.(type) {
	case nil:
		return &OrderedValue{kind: orderedNull}, nil
	case bool:
		return &OrderedValue{kind: orderedBool, b: typed}, nil
	case string:
		return &OrderedValue{kind: orderedString, str: typed}, nil
	case json.Number:
		return &OrderedValue{kind: orderedNumber, num: json.RawMessage(typed.String())}, nil
	case json.Delim:
		switch typed {
		case '{':
			obj := &OrderedValue{kind: orderedObject}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("config.json object key is not a string")
				}
				member, err := decodeOrderedNext(decoder)
				if err != nil {
					return nil, err
				}
				obj.obj = append(obj.obj, orderedMember{key: key, val: member})
			}
			// Consume the closing '}'.
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := &OrderedValue{kind: orderedArray}
			for decoder.More() {
				member, err := decodeOrderedNext(decoder)
				if err != nil {
					return nil, err
				}
				arr.arr = append(arr.arr, member)
			}
			// Consume the closing ']'.
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		default:
			return nil, errors.New("config.json contains an unexpected delimiter")
		}
	default:
		return nil, errors.New("config.json contains an unsupported token")
	}
}

// Find returns the member with the given key, or nil when absent. Object key
// order is preserved by decodeOrdered; callers that re-emit the value rely on
// that order being the file's.
func (v *OrderedValue) Find(key string) *OrderedValue {
	if v == nil || v.kind != orderedObject {
		return nil
	}
	for _, member := range v.obj {
		if member.key == key {
			return member.val
		}
	}
	return nil
}

// Entries returns the object's members in document order. A non-object has no
// entries. The returned slice is a copy so callers cannot mutate the tree.
func (v *OrderedValue) Entries() []OrderedEntry {
	if v == nil || v.kind != orderedObject {
		return nil
	}
	entries := make([]OrderedEntry, len(v.obj))
	for i, member := range v.obj {
		entries[i] = OrderedEntry{Key: member.key, Value: member.val}
	}
	return entries
}

// Elements returns an array's values in document order. A non-array has no
// elements. The returned slice is a copy.
func (v *OrderedValue) Elements() []*OrderedValue {
	if v == nil || v.kind != orderedArray {
		return nil
	}
	return append([]*OrderedValue(nil), v.arr...)
}

// StringValue returns a JSON string's decoded value.
func (v *OrderedValue) StringValue() (string, bool) {
	if v == nil || v.kind != orderedString {
		return "", false
	}
	return v.str, true
}

// JSONStringifyString exports the package's ECMAScript-compatible string
// escaping for projections that construct a new object around ordered values.
func JSONStringifyString(value string) ([]byte, error) {
	return marshalStringJSONStringify(value)
}

// ECMAScriptEntries returns object entries in Object.entries order: canonical
// array-index keys first by numeric value, followed by other keys in document
// order. Projection routes use it when mirroring TypeScript object iteration.
func (v *OrderedValue) ECMAScriptEntries() []OrderedEntry {
	entries := v.Entries()
	if len(entries) < 2 {
		return entries
	}
	indices := make([]OrderedEntry, 0, len(entries))
	rest := make([]OrderedEntry, 0, len(entries))
	for _, entry := range entries {
		if index, ok := ecmaArrayIndex(entry.Key); ok {
			entry.index = index
			indices = append(indices, entry)
		} else {
			rest = append(rest, entry)
		}
	}
	slices.SortFunc(indices, func(a, b OrderedEntry) int { return cmp.Compare(a.index, b.index) })
	return append(indices, rest...)
}

func ecmaArrayIndex(key string) (uint32, bool) {
	if key == "0" {
		return 0, true
	}
	if key == "" || key[0] == '0' {
		return 0, false
	}
	value, err := strconv.ParseUint(key, 10, 32)
	if err != nil || value >= 4294967295 || strconv.FormatUint(value, 10) != key {
		return 0, false
	}
	return uint32(value), true
}

// IsNull reports whether the value is the JSON null literal.
func (v *OrderedValue) IsNull() bool {
	return v != nil && v.kind == orderedNull
}

// MarshalStringify writes the value the way ECMAScript JSON.stringify does:
// compact, no HTML or U+2028/U+2029 escaping, object keys in document order.
// Number literals are emitted verbatim (see the package comment for why raw
// echo equals JavaScript output for TypeScript-written config files).
func (v *OrderedValue) MarshalStringify() ([]byte, error) {
	var out bytes.Buffer
	if err := v.marshalJSONStringify(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (v *OrderedValue) marshalJSONStringify(out *bytes.Buffer) error {
	switch v.kind {
	case orderedNull:
		out.WriteString("null")
	case orderedBool:
		if v.b {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case orderedString:
		raw, err := marshalStringJSONStringify(v.str)
		if err != nil {
			return err
		}
		out.Write(raw)
	case orderedNumber:
		out.Write(v.num)
	case orderedArray:
		out.WriteByte('[')
		for i, member := range v.arr {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := member.marshalJSONStringify(out); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case orderedObject:
		out.WriteByte('{')
		for i, member := range v.obj {
			if i > 0 {
				out.WriteByte(',')
			}
			rawKey, err := marshalStringJSONStringify(member.key)
			if err != nil {
				return err
			}
			out.Write(rawKey)
			out.WriteByte(':')
			if err := member.val.marshalJSONStringify(out); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	}
	return nil
}

// marshalStringJSONStringify encodes one string the way ECMAScript
// JSON.stringify does. encoding/json cannot be used directly: with HTML
// escaping disabled it still escapes U+2028/U+2029, while V8 emits them
// literally (verified against Bun), so the escaping is done here by hand.
// Rules pinned against JSON.stringify: quotes and backslashes are escaped, the
// five control characters get \b \t \n \f \r shortcuts, other code points
// below U+0020 become \u00xx (lowercase), and everything else — DEL, U+0080,
// U+2028/U+2029 included — is emitted literally as UTF-8.
func marshalStringJSONStringify(value string) ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\t':
			out.WriteString(`\t`)
		case '\n':
			out.WriteString(`\n`)
		case '\f':
			out.WriteString(`\f`)
		case '\r':
			out.WriteString(`\r`)
		default:
			if r < 0x20 {
				hexDigits := "0123456789abcdef"
				out.WriteString(`\u00`)
				out.WriteByte(hexDigits[r>>4])
				out.WriteByte(hexDigits[r&0xf])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.Bytes(), nil
}
