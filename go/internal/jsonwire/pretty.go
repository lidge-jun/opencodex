package jsonwire

import "bytes"

// EncodePretty emits the value exactly like ECMAScript JSON.stringify(value,
// null, 2): the same compact member/element order and string/number encoding
// as Encode, but with each object member and array element on its own line,
// indented two spaces per nesting level, and `": "` after each object key.
//
// The CLI parity surface needs this because the TypeScript command layer
// reports many management DTOs with console.log(JSON.stringify(x, null, 2)),
// and re-encoding through Go's encoding/json would differ in key order, number
// literals, and string escaping. Empty objects and arrays stay on one line,
// exactly as V8 emits them.
func (v *Value) EncodePretty() ([]byte, error) {
	var out bytes.Buffer
	if err := v.encodePretty(&out, 0); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (v *Value) encodePretty(out *bytes.Buffer, depth int) error {
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
		if len(v.arr) == 0 {
			out.WriteString("[]")
			return nil
		}
		out.WriteByte('[')
		for i, member := range v.arr {
			if i > 0 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
			writePrettyIndent(out, depth+1)
			if err := member.encodePretty(out, depth+1); err != nil {
				return err
			}
		}
		out.WriteByte('\n')
		writePrettyIndent(out, depth)
		out.WriteByte(']')
	case Object:
		members := orderedObjectMembers(v.obj)
		if len(members) == 0 {
			out.WriteString("{}")
			return nil
		}
		out.WriteByte('{')
		for i, member := range members {
			if i > 0 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
			writePrettyIndent(out, depth+1)
			rawKey, err := EncodeString(member.Key)
			if err != nil {
				return err
			}
			out.Write(rawKey)
			out.WriteString(": ")
			if err := member.Value.encodePretty(out, depth+1); err != nil {
				return err
			}
		}
		out.WriteByte('\n')
		writePrettyIndent(out, depth)
		out.WriteByte('}')
	default:
		out.WriteString("null")
	}
	return nil
}

func writePrettyIndent(out *bytes.Buffer, depth int) {
	for i := 0; i < depth; i++ {
		out.WriteString("  ")
	}
}
