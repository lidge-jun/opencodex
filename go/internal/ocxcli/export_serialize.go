package ocxcli

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex/go/internal/jsonwire"
)

// export_serialize.go — port of src/integrations/serialize.ts. Client export
// text formats: JSON (reuses encodeIndentedJSON), block-style YAML, and TOML
// render exactly like the TypeScript hand-renderers, plus the JSON5 spelling
// Bun.JSON5.stringify produces for the shallow identifier-keyed shapes the
// openclaw exporter emits (single-quoted strings, bare identifier keys).

type exportFormat string

const (
	exportFormatJSON  exportFormat = "json"
	exportFormatYAML  exportFormat = "yaml"
	exportFormatTOML  exportFormat = "toml"
	exportFormatJSON5 exportFormat = "json5"
)

func serializeExportDocument(document *jsonwire.Value, format exportFormat) (string, error) {
	switch format {
	case exportFormatJSON:
		var out strings.Builder
		if err := encodeIndentedJSON(&out, document, 0); err != nil {
			return "", err
		}
		return out.String() + "\n", nil
	case exportFormatJSON5:
		return renderJSON5(document, 0)
	case exportFormatYAML:
		lines, err := yamlExportLines(document, 0)
		if err != nil {
			return "", err
		}
		return strings.Join(lines, "\n") + "\n", nil
	case exportFormatTOML:
		if document.Kind() != jsonwire.Object {
			return "", errors.New("TOML root must be a table")
		}
		return renderExportToml(document, ""), nil
	}
	return "", fmt.Errorf("unknown export format %s", format)
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON5 — mirrors Bun.JSON5.stringify(value, null, 2) for the identifier-keyed
// shapes the openclaw document emits.

var exportIdentifierKeyRe = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

func json5String(value string) string {
	var b strings.Builder
	b.WriteByte('\'')
	for _, character := range value {
		switch character {
		case '\\':
			b.WriteString(`\\`)
		case '\'':
			b.WriteString(`\'`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if character < 0x20 {
				b.WriteString(fmt.Sprintf(`\u%04x`, character))
			} else {
				b.WriteRune(character)
			}
		}
	}
	b.WriteByte('\'')
	return b.String()
}

func renderJSON5(value *jsonwire.Value, depth int) (string, error) {
	switch value.Kind() {
	case jsonwire.Null:
		return "null", nil
	case jsonwire.Bool:
		if value.Bool() {
			return "true", nil
		}
		return "false", nil
	case jsonwire.Number:
		return value.NumberRaw(), nil
	case jsonwire.String:
		return json5String(value.String()), nil
	case jsonwire.Array:
		elements := value.Elements()
		if len(elements) == 0 {
			return "[]", nil
		}
		var b strings.Builder
		b.WriteString("[\n")
		for _, element := range elements {
			rendered, err := renderJSON5(element, depth+1)
			if err != nil {
				return "", err
			}
			b.WriteString(strings.Repeat("  ", depth+1))
			b.WriteString(rendered + ",\n")
		}
		b.WriteString(strings.Repeat("  ", depth))
		b.WriteString("]")
		return b.String(), nil
	case jsonwire.Object:
		members := value.Members()
		if len(members) == 0 {
			return "{}", nil
		}
		var b strings.Builder
		b.WriteString("{\n")
		for _, member := range members {
			key := member.Key
			if !exportIdentifierKeyRe.MatchString(key) {
				key = json5String(key)
			}
			rendered, err := renderJSON5(member.Value, depth+1)
			if err != nil {
				return "", err
			}
			b.WriteString(strings.Repeat("  ", depth+1))
			b.WriteString(key + ": " + rendered + ",\n")
		}
		b.WriteString(strings.Repeat("  ", depth))
		b.WriteString("}")
		return b.String(), nil
	}
	return "", errors.New("cannot render json5 value")
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML — block style port of renderYaml.

var exportYamlPlainRe = regexp.MustCompile(`^[A-Za-z_./][A-Za-z0-9_./-]*$`)
var exportYamlReservedRe = regexp.MustCompile(`(?i)^(?:null|true|false|yes|no|on|off|~|\.nan|[-+]?\.inf)$`)

func yamlExportString(value string) string {
	if value != "" && strings.TrimSpace(value) == value &&
		exportYamlPlainRe.MatchString(value) && !exportYamlReservedRe.MatchString(value) {
		return value
	}
	quoted, err := jsonwire.EncodeString(value)
	if err != nil {
		return json5String(value) // unreachable for finite strings
	}
	return string(quoted)
}

func yamlExportScalar(value *jsonwire.Value) (string, error) {
	switch value.Kind() {
	case jsonwire.Null:
		return "null", nil
	case jsonwire.String:
		return yamlExportString(value.String()), nil
	case jsonwire.Bool:
		if value.Bool() {
			return "true", nil
		}
		return "false", nil
	case jsonwire.Number:
		raw := value.NumberRaw()
		return raw, nil
	}
	return "", errors.New("yaml cannot represent container value in scalar position")
}

func yamlExportIsScalar(value *jsonwire.Value) bool {
	if value == nil {
		return false
	}
	switch value.Kind() {
	case jsonwire.Null, jsonwire.String, jsonwire.Number, jsonwire.Bool:
		return true
	}
	return false
}

func yamlExportEmptyCollection(value *jsonwire.Value) (string, bool) {
	if value == nil {
		return "", false
	}
	if value.Kind() == jsonwire.Array && len(value.Elements()) == 0 {
		return "[]", true
	}
	if value.Kind() == jsonwire.Object && len(value.Members()) == 0 {
		return "{}", true
	}
	return "", false
}

// yamlExportMapEntryLines renders `key: <value>` inside a map at indent.
func yamlExportMapEntryLines(key string, value *jsonwire.Value, indent int) ([]string, error) {
	padding := strings.Repeat(" ", indent)
	renderedKey := yamlExportString(key)
	if yamlExportIsScalar(value) {
		scalar, err := yamlExportScalar(value)
		if err != nil {
			return nil, err
		}
		return []string{padding + renderedKey + ": " + scalar}, nil
	}
	if empty, ok := yamlExportEmptyCollection(value); ok {
		return []string{padding + renderedKey + ": " + empty}, nil
	}
	lines := []string{padding + renderedKey + ":"}
	child, err := yamlExportLines(value, indent+2)
	if err != nil {
		return nil, err
	}
	return append(lines, child...), nil
}

// yamlExportArrayMapLines renders a record as a `- key: value` sequence item.
func yamlExportArrayMapLines(value *jsonwire.Value, indent int) ([]string, error) {
	members := value.Members()
	padding := strings.Repeat(" ", indent)
	if len(members) == 0 {
		return []string{padding + "- {}"}, nil
	}
	first := members[0]
	rest := members[1:]
	renderedFirstKey := yamlExportString(first.Key)
	var lines []string
	if yamlExportIsScalar(first.Value) {
		scalar, err := yamlExportScalar(first.Value)
		if err != nil {
			return nil, err
		}
		lines = append(lines, padding+"- "+renderedFirstKey+": "+scalar)
	} else if empty, ok := yamlExportEmptyCollection(first.Value); ok {
		lines = append(lines, padding+"- "+renderedFirstKey+": "+empty)
	} else {
		lines = append(lines, padding+"- "+renderedFirstKey+":")
		child, err := yamlExportLines(first.Value, indent+4)
		if err != nil {
			return nil, err
		}
		lines = append(lines, child...)
	}
	for _, member := range rest {
		entry, err := yamlExportMapEntryLines(member.Key, member.Value, indent+2)
		if err != nil {
			return nil, err
		}
		lines = append(lines, entry...)
	}
	return lines, nil
}

func yamlExportLines(value *jsonwire.Value, indent int) ([]string, error) {
	padding := strings.Repeat(" ", indent)
	if yamlExportIsScalar(value) {
		scalar, err := yamlExportScalar(value)
		if err != nil {
			return nil, err
		}
		return []string{padding + scalar}, nil
	}
	if value.Kind() == jsonwire.Array {
		elements := value.Elements()
		if len(elements) == 0 {
			return []string{padding + "[]"}, nil
		}
		var lines []string
		for _, item := range elements {
			if yamlExportIsScalar(item) {
				scalar, err := yamlExportScalar(item)
				if err != nil {
					return nil, err
				}
				lines = append(lines, padding+"- "+scalar)
				continue
			}
			if item.Kind() == jsonwire.Object {
				entry, err := yamlExportArrayMapLines(item, indent)
				if err != nil {
					return nil, err
				}
				lines = append(lines, entry...)
				continue
			}
			if item.Kind() == jsonwire.Array {
				if len(item.Elements()) == 0 {
					lines = append(lines, padding+"- []")
				} else {
					lines = append(lines, padding+"-")
					child, err := yamlExportLines(item, indent+2)
					if err != nil {
						return nil, err
					}
					lines = append(lines, child...)
				}
				continue
			}
			return nil, errors.New("yaml cannot represent this sequence item")
		}
		return lines, nil
	}
	if value.Kind() == jsonwire.Object {
		members := value.Members()
		if len(members) == 0 {
			return []string{padding + "{}"}, nil
		}
		var lines []string
		for _, member := range members {
			entry, err := yamlExportMapEntryLines(member.Key, member.Value, indent)
			if err != nil {
				return nil, err
			}
			lines = append(lines, entry...)
		}
		return lines, nil
	}
	return nil, errors.New("yaml cannot represent this value")
}

// ─────────────────────────────────────────────────────────────────────────────
// TOML — port of renderToml + tomlString + quoteTomlKey.

var exportTomlBareKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func exportTomlString(value string) string {
	quoted, err := jsonwire.EncodeString(value)
	if err != nil {
		return value
	}
	return string(quoted)
}

func exportQuoteTomlKey(key string) string {
	if exportTomlBareKeyRe.MatchString(key) {
		return key
	}
	return exportTomlString(key)
}

func exportTomlScalar(value *jsonwire.Value) (string, error) {
	switch value.Kind() {
	case jsonwire.String:
		return exportTomlString(value.String()), nil
	case jsonwire.Bool:
		if value.Bool() {
			return "true", nil
		}
		return "false", nil
	case jsonwire.Number:
		return value.NumberRaw(), nil
	case jsonwire.Array:
		parts := make([]string, 0, len(value.Elements()))
		for _, element := range value.Elements() {
			rendered, err := exportTomlScalar(element)
			if err != nil {
				return "", err
			}
			parts = append(parts, rendered)
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	case jsonwire.Object:
		parts := make([]string, 0, len(value.Members()))
		for _, member := range value.Members() {
			rendered, err := exportTomlScalar(member.Value)
			if err != nil {
				return "", err
			}
			parts = append(parts, exportQuoteTomlKey(member.Key)+" = "+rendered)
		}
		return "{ " + strings.Join(parts, ", ") + " }", nil
	}
	return "", errors.New("toml cannot represent this value")
}

// renderExportToml mirrors renderToml(document, prefix): scalars first in
// document order, then each nested table as a `[path]` section whose own
// scalars and tables follow recursively; sections join with blank lines and
// the whole document ends with one newline.
func renderExportToml(document *jsonwire.Value, prefix string) string {
	var scalars []string
	var tables []string
	for _, member := range document.Members() {
		path := exportQuoteTomlKey(member.Key)
		if prefix != "" {
			path = prefix + "." + exportQuoteTomlKey(member.Key)
		}
		if member.Value.Kind() == jsonwire.Object {
			body := renderExportToml(member.Value, path)
			tables = append(tables, "["+path+"]\n"+strings.TrimRight(body, "\n"))
		} else {
			rendered, err := exportTomlScalar(member.Value)
			if err != nil {
				return ""
			}
			scalars = append(scalars, exportQuoteTomlKey(member.Key)+" = "+rendered)
		}
	}
	var sections []string
	if len(scalars) > 0 {
		sections = append(sections, strings.Join(scalars, "\n"))
	}
	if len(tables) > 0 {
		sections = append(sections, strings.Join(tables, "\n\n"))
	}
	return strings.Join(sections, "\n\n") + "\n"
}
