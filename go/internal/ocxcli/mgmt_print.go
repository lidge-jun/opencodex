package ocxcli

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// printManagementData mirrors printData: JSON.stringify(value, null, 2) when
// json output was requested or no human lines exist; otherwise the lines, each
// on its own stdout row via console.log semantics.
func printManagementData(deps Deps, body *jsonwire.Value, rawText string, wantsJSON bool, lines []string) {
	if wantsJSON || lines == nil {
		value := body
		if value == nil {
			if rawText == "" {
				// Empty 2xx body: runtimeRequest keeps body = null, so
				// JSON.stringify(null) prints null.
				fmt.Fprintln(deps.Stdout, "null")
				return
			}
			// Non-JSON body: JSON.stringify(text) is a quoted string.
			quoted, err := jsonwire.EncodeString(rawText)
			if err != nil {
				fmt.Fprintln(deps.Stderr, err)
				return
			}
			fmt.Fprintln(deps.Stdout, string(quoted))
			return
		}
		var out strings.Builder
		if err := indentJSONWire(&out, value, 0); err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return
		}
		fmt.Fprintln(deps.Stdout, out.String())
		return
	}
	for _, line := range lines {
		fmt.Fprintln(deps.Stdout, line)
	}
}

// indentJSONWire renders a jsonwire value with JSON.stringify(v, null, 2)
// whitespace and V8 number canonicalisation (jsonwire.FormatV8Number), not the
// raw literal, so parsed exponent/duplicate forms re-emit exactly like V8.
func indentJSONWire(out *strings.Builder, value *jsonwire.Value, depth int) error {
	switch value.Kind() {
	case jsonwire.Array:
		elements := value.Elements()
		if len(elements) == 0 {
			out.WriteString("[]")
			return nil
		}
		out.WriteString("[\n")
		for i, element := range elements {
			writeJSONIndent(out, depth+1)
			if err := indentJSONWire(out, element, depth+1); err != nil {
				return err
			}
			if i < len(elements)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		writeJSONIndent(out, depth)
		out.WriteByte(']')
	case jsonwire.Object:
		members := value.Members()
		if len(members) == 0 {
			out.WriteString("{}")
			return nil
		}
		out.WriteString("{\n")
		for i, member := range members {
			writeJSONIndent(out, depth+1)
			quoted, err := jsonwire.EncodeString(member.Key)
			if err != nil {
				return err
			}
			out.Write(quoted)
			out.WriteString(": ")
			if err := indentJSONWire(out, member.Value, depth+1); err != nil {
				return err
			}
			if i < len(members)-1 {
				out.WriteByte(',')
			}
			out.WriteByte('\n')
		}
		writeJSONIndent(out, depth)
		out.WriteByte('}')
	case jsonwire.String:
		quoted, err := jsonwire.EncodeString(value.String())
		if err != nil {
			return err
		}
		out.Write(quoted)
	case jsonwire.Number:
		out.WriteString(canonicalJSONNumber(value.NumberRaw()))
	case jsonwire.Bool:
		if value.Bool() {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	default:
		out.WriteString("null")
	}
	return nil
}

func writeJSONIndent(out *strings.Builder, depth int) {
	for i := 0; i < depth; i++ {
		out.WriteString("  ")
	}
}

// canonicalJSONNumber renders a raw JSON number literal the way V8
// JSON.stringify does after JSON.parse (shortest round-trip decimal). Raw
// literals that are already canonical pass through unchanged.
func canonicalJSONNumber(raw string) string {
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return raw
	}
	return jsonwire.FormatV8Number(value)
}

// summaryLinesFor renders the compact human view of a request result the way
// the TS renderer sees it: a parsed JSON object flattens; a non-JSON body is a
// JS string ("value: <text>"); an empty body is null ("value: null").
func summaryLinesFor(body *jsonwire.Value, rawText string) []string {
	if body == nil {
		if rawText != "" {
			return []string{"value: " + rawText}
		}
		return []string{"value: null"}
	}
	return summaryLines(body)
}

// summaryLines is the compact human view port (src/cli/runtime-api.ts
// summaryLines): flatten an object to "label: value" rows, recursing one level
// into objects, rendering arrays as joined scalars or "N item(s)", and dashes
// for null/undefined/empty leaves. Document key order is preserved.
func summaryLines(value *jsonwire.Value) []string {
	if value == nil || value.Kind() != jsonwire.Object {
		return []string{prefixLeaf("", value)}
	}
	var lines []string
	for _, member := range value.Members() {
		lines = append(lines, summarizeMember(member.Key, member.Value, 0)...)
	}
	return lines
}

func prefixLeaf(prefix string, value *jsonwire.Value) string {
	name := prefix
	if name == "" {
		name = "value"
	}
	return name + ": " + jsString(value)
}

func summarizeMember(key string, child *jsonwire.Value, depth int) []string {
	if child != nil && child.Kind() == jsonwire.Array {
		scalar := true
		for _, item := range child.Elements() {
			if item == nil || (item.Kind() != jsonwire.String && item.Kind() != jsonwire.Number && item.Kind() != jsonwire.Bool && item.Kind() != jsonwire.Null) {
				scalar = false
				break
			}
		}
		text := fmt.Sprintf("%d item(s)", len(child.Elements()))
		if scalar {
			joined := jsArrayJoin(child)
			if joined != "" {
				text = joined
			} else {
				text = "none"
			}
		}
		return []string{key + ": " + text}
	}
	if child != nil && child.Kind() == jsonwire.Object && depth < 1 {
		var lines []string
		for _, nested := range child.Members() {
			lines = append(lines, summarizeMember(key+"."+nested.Key, nested.Value, depth+1)...)
		}
		return lines
	}
	// Leaf: null/undefined/empty string become a dash.
	if child == nil || child.Kind() == jsonwire.Null || (child.Kind() == jsonwire.String && child.String() == "") {
		return []string{key + ": -"}
	}
	return []string{key + ": " + jsString(child)}
}

// jsString mirrors String(value) in JS for the value kinds these DTOs carry:
// strings verbatim, booleans true/false, numbers in V8 form, objects as
// [object Object], and null as "null".
func jsString(value *jsonwire.Value) string {
	if value == nil || value.Kind() == jsonwire.Null {
		return "null"
	}
	switch value.Kind() {
	case jsonwire.String:
		return value.String()
	case jsonwire.Bool:
		return strconv.FormatBool(value.Bool())
	case jsonwire.Number:
		return canonicalJSONNumber(value.NumberRaw())
	case jsonwire.Object:
		return "[object Object]"
	default:
		return fmt.Sprint(value)
	}
}

// jsArrayJoin mirrors Array.prototype.join(", "): null/undefined items become
// the empty string, strings verbatim, numbers and booleans via String().
func jsArrayJoin(value *jsonwire.Value) string {
	parts := make([]string, 0, len(value.Elements()))
	for _, item := range value.Elements() {
		if item == nil || item.Kind() == jsonwire.Null {
			parts = append(parts, "")
			continue
		}
		parts = append(parts, jsString(item))
	}
	return strings.Join(parts, ", ")
}

// formatENUSNumber renders a float64 the way Number.prototype.toLocaleString
// ("en-US") does for the integer magnitudes these DTOs carry: grouped integer
// digits with commas, fraction only for non-integers.
func formatENUSNumber(value float64) string {
	if value == math.Trunc(value) && math.Abs(value) < 1e15 {
		return groupDigits(strconv.FormatInt(int64(value), 10))
	}
	fixed := strconv.FormatFloat(value, 'f', -1, 64)
	intPart, fracPart, _ := strings.Cut(fixed, ".")
	return groupDigits(intPart) + "." + fracPart
}
