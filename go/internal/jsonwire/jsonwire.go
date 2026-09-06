// Package jsonwire implements the JSON value model the Go hot-path relay
// needs to reproduce TypeScript's byte behaviour when it re-serialises a
// parsed Responses payload (ticket #27, devlog 036).
//
// The hard requirement is that re-encoding a parsed value emits exactly what
// ECMAScript JSON.stringify would emit, because the TS oracle re-serialises a
// repaired upstream body with JSON.stringify and the differential compares raw
// client-visible bytes:
//
//   - Object keys keep document order (encoding/json maps would discard it).
//   - Strings are escaped exactly like V8: quotes/backslashes and the five
//     control shortcuts, \u00xx for other controls, and everything above
//     U+0020 — DEL, U+0080, U+2028/U+2029 included — emitted literally as
//     UTF-8 (no HTML escaping).
//   - Numbers are re-serialised from the parsed float64 the way V8's
//     Number::toString does (shortest round-trip decimal, exponent form only
//     outside the (-6, 21] decimal window, no zero-padded exponents), NOT with
//     encoding/json's rules.
//
// Untouched payloads must never be routed through this encoder: the relay
// emits the original raw bytes when a repair changes nothing, exactly like the
// TS bounded-JSON path, so a lost canonicalisation is only ever observable on
// a payload the repair actually rewrote.
package jsonwire

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strconv"
)

// Kind classifies a Value.
type Kind int

const (
	Null Kind = iota
	Bool
	Number
	String
	Array
	Object
)

// Member is one object member in document order.
type Member struct {
	Key   string
	Value *Value
}

// Value is one JSON value with object keys in document order and numbers kept
// as their raw JSON literal until encode time.
type Value struct {
	kind Kind
	b    bool
	num  string // raw literal for Number
	str  string // decoded string for String
	arr  []*Value
	obj  []Member
}

// Parse decodes one JSON document into an ordered value tree. A second value
// in the stream is an error, matching the config echo loader's contract.
func Parse(data []byte) (*Value, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeNext(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, errors.New("jsonwire: input contains more than one JSON value")
		}
		return nil, err
	}
	return value, nil
}

func decodeNext(decoder *json.Decoder) (*Value, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	return decodeValue(decoder, token)
}

func decodeValue(decoder *json.Decoder, token json.Token) (*Value, error) {
	switch typed := token.(type) {
	case nil:
		return &Value{kind: Null}, nil
	case bool:
		return &Value{kind: Bool, b: typed}, nil
	case string:
		return &Value{kind: String, str: typed}, nil
	case json.Number:
		return &Value{kind: Number, num: typed.String()}, nil
	case json.Delim:
		switch typed {
		case '{':
			obj := &Value{kind: Object}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("jsonwire: object key is not a string")
				}
				member, err := decodeNext(decoder)
				if err != nil {
					return nil, err
				}
				// JSON.parse keeps the last duplicate value but does not move the
				// property's original insertion position. Preserve that observable
				// V8 object semantics for any payload we later re-serialize.
				replaced := false
				for i := range obj.obj {
					if obj.obj[i].Key == key {
						obj.obj[i].Value = member
						replaced = true
						break
					}
				}
				if !replaced {
					obj.obj = append(obj.obj, Member{Key: key, Value: member})
				}
			}
			if _, err := decoder.Token(); err != nil { // consume '}'
				return nil, err
			}
			return obj, nil
		case '[':
			arr := &Value{kind: Array}
			for decoder.More() {
				member, err := decodeNext(decoder)
				if err != nil {
					return nil, err
				}
				arr.arr = append(arr.arr, member)
			}
			if _, err := decoder.Token(); err != nil { // consume ']'
				return nil, err
			}
			return arr, nil
		default:
			return nil, errors.New("jsonwire: unexpected delimiter")
		}
	default:
		return nil, errors.New("jsonwire: unsupported token")
	}
}

// Kind reports the value's kind.
func (v *Value) Kind() Kind {
	if v == nil {
		return Null
	}
	return v.kind
}

// Bool returns a Bool value's payload.
func (v *Value) Bool() bool { return v != nil && v.kind == Bool && v.b }

// NumberRaw returns a Number value's raw JSON literal.
func (v *Value) NumberRaw() string {
	if v == nil || v.kind != Number {
		return ""
	}
	return v.num
}

// String returns a String value's decoded payload.
func (v *Value) String() string {
	if v == nil || v.kind != String {
		return ""
	}
	return v.str
}

// Members returns an Object's members in document order. The returned slice is
// a copy.
func (v *Value) Members() []Member {
	if v == nil || v.kind != Object {
		return nil
	}
	return append([]Member(nil), v.obj...)
}

// Elements returns an Array's elements in document order. The returned slice
// is a copy.
func (v *Value) Elements() []*Value {
	if v == nil || v.kind != Array {
		return nil
	}
	return append([]*Value(nil), v.arr...)
}

// Find returns the member with the given key, or nil when absent. The returned
// Value is the live tree node.
func (v *Value) Find(key string) *Value {
	if v == nil || v.kind != Object {
		return nil
	}
	for i := range v.obj {
		if v.obj[i].Key == key {
			return v.obj[i].Value
		}
	}
	return nil
}

// Set replaces the member with the given key, or appends it at the end when
// absent. Key position is preserved for existing members and new members are
// appended — the exact semantics of a TypeScript object spread.
func (v *Value) Set(key string, member *Value) {
	if v == nil || v.kind != Object {
		return
	}
	for i := range v.obj {
		if v.obj[i].Key == key {
			v.obj[i].Value = member
			return
		}
	}
	v.obj = append(v.obj, Member{Key: key, Value: member})
}

// Constructors for the values a repair synthesises (strings, empty arrays,
// booleans). Numbers are not synthesised by the current transforms; NumberFrom
// exists so future transforms can stay on the same tree.
func NullValue() *Value               { return &Value{kind: Null} }
func BoolValue(value bool) *Value     { return &Value{kind: Bool, b: value} }
func StringValue(value string) *Value { return &Value{kind: String, str: value} }
func EmptyArray() *Value              { return &Value{kind: Array} }

// NumberFrom builds a Number value from a float64. The literal is canonical
// V8 form, so encode round-trips it unchanged.
func NumberFrom(value float64) *Value {
	return &Value{kind: Number, num: FormatV8Number(value)}
}

// AppendArray appends an element to an Array value.
func (v *Value) AppendArray(element *Value) {
	if v == nil || v.kind != Array {
		return
	}
	v.arr = append(v.arr, element)
}

// Encode emits the value exactly like ECMAScript JSON.stringify: compact, no
// HTML/U+2028/U+2029 escaping, array-index object keys in ascending numeric
// order followed by other keys in document order, and numbers in V8
// shortest-decimal form.
func (v *Value) Encode() ([]byte, error) {
	var out bytes.Buffer
	if err := v.encode(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (v *Value) encode(out *bytes.Buffer) error {
	switch v.kind {
	case Null:
		out.WriteString("null")
	case Bool:
		if v.b {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case Number:
		out.WriteString(v8NumberString(v.num))
	case String:
		raw, err := EncodeString(v.str)
		if err != nil {
			return err
		}
		out.Write(raw)
	case Array:
		out.WriteByte('[')
		for i, member := range v.arr {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := member.encode(out); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case Object:
		out.WriteByte('{')
		members := orderedObjectMembers(v.obj)
		for i, member := range members {
			if i > 0 {
				out.WriteByte(',')
			}
			rawKey, err := EncodeString(member.Key)
			if err != nil {
				return err
			}
			out.Write(rawKey)
			out.WriteByte(':')
			if err := member.Value.encode(out); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		out.WriteString("null")
	}
	return nil
}

// orderedObjectMembers applies ECMAScript's own-property order for the string
// keys that JSON can contain: array-index keys first in ascending numeric
// order, followed by all other keys in their insertion order.
func orderedObjectMembers(members []Member) []Member {
	ordered := append([]Member(nil), members...)
	sort.SliceStable(ordered, func(i, j int) bool {
		left, leftIsIndex := arrayIndex(ordered[i].Key)
		right, rightIsIndex := arrayIndex(ordered[j].Key)
		if leftIsIndex != rightIsIndex {
			return leftIsIndex
		}
		return leftIsIndex && left < right
	})
	return ordered
}

// arrayIndex returns the numeric value for an ECMAScript array-index property
// key. An index is its canonical decimal spelling in [0, 2^32-2]; 2^32-1 is
// deliberately excluded by the specification.
func arrayIndex(key string) (uint32, bool) {
	if key == "0" {
		return 0, true
	}
	if len(key) == 0 || key[0] < '1' || key[0] > '9' || len(key) > 10 {
		return 0, false
	}
	var value uint64
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, false
		}
		value = value*10 + uint64(key[i]-'0')
	}
	if value >= (1<<32)-1 {
		return 0, false
	}
	return uint32(value), true
}

// EncodeString encodes one string the way ECMAScript JSON.stringify does.
// encoding/json cannot be used directly: with HTML escaping disabled it still
// escapes U+2028/U+2029, while V8 emits them literally (verified against Bun).
func EncodeString(value string) ([]byte, error) {
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
				const hex = "0123456789abcdef"
				out.WriteString(`\u00`)
				out.WriteByte(hex[r>>4])
				out.WriteByte(hex[r&0xf])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.Bytes(), nil
}

// v8NumberString re-serialises a raw JSON number literal the way V8's
// JSON.stringify would after parsing it to a JS Number.
func v8NumberString(raw string) string {
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		// The literal came from a valid JSON decoder, so this cannot fail;
		// keep the raw literal rather than inventing bytes.
		return raw
	}
	return FormatV8Number(f)
}

// FormatV8Number formats a float64 exactly like ECMAScript Number::toString(10)
// (which JSON.stringify uses). Zero (including -0) is "0".
func FormatV8Number(f float64) string {
	if f == 0 {
		return "0"
	}
	if f < 0 {
		return "-" + formatV8Positive(-f)
	}
	return formatV8Positive(f)
}

// formatV8Positive assumes f > 0.
func formatV8Positive(f float64) string {
	// strconv's shortest 'e' form is the correctly-rounded shortest decimal
	// (the same number ECMAScript's toString algorithm produces), e.g.
	// "1.2345e+20", "1e-07". Rewrite it into ECMAScript's formatting rules:
	// decimal notation when -6 < s <= 21 (s = decimal exponent of the first
	// significant digit), exponent form otherwise with an unpadded exponent.
	short := strconv.FormatFloat(f, 'e', -1, 64)
	expPos := -1
	for i := len(short) - 1; i >= 0; i-- {
		if short[i] == 'e' {
			expPos = i
			break
		}
	}
	mantissa := short[:expPos]
	exp, _ := strconv.Atoi(short[expPos+1:])
	digits := make([]byte, 0, len(mantissa))
	for _, c := range []byte(mantissa) {
		if c != '.' {
			digits = append(digits, c)
		}
	}
	// s = 1 + exp: the place value of the first digit relative to the units.
	s := 1 + exp
	k := len(digits)

	if s > 21 || s <= -6 {
		var out bytes.Buffer
		out.WriteByte(digits[0])
		if k > 1 {
			out.WriteByte('.')
			out.Write(digits[1:])
		}
		out.WriteByte('e')
		exponent := s - 1
		if exponent >= 0 {
			out.WriteByte('+')
		} else {
			out.WriteByte('-')
			exponent = -exponent
		}
		out.WriteString(strconv.Itoa(exponent))
		return out.String()
	}
	if s >= k {
		// Integer: pad with zeros up to the decimal position.
		out := make([]byte, 0, s)
		out = append(out, digits...)
		for i := k; i < s; i++ {
			out = append(out, '0')
		}
		return string(out)
	}
	if s > 0 {
		out := make([]byte, 0, k+1)
		out = append(out, digits[:s]...)
		out = append(out, '.')
		out = append(out, digits[s:]...)
		return string(out)
	}
	// 0.00…digits
	out := make([]byte, 0, k+2-s)
	out = append(out, '0', '.')
	for i := 0; i < -s; i++ {
		out = append(out, '0')
	}
	out = append(out, digits...)
	return string(out)
}
