package ocxcli

// YAML-subset reader for the MiniMax Code launcher's config destination check.
//
// opencodex writes the managed MCode provider document with the block renderer
// in src/integrations/serialize.ts (nested indented maps, scalar/flow leaves);
// older hand-written and test fixtures may carry the single-line FLOW shape
// ({custom_provider: {opencodex: {options: {baseURL: http://…}}}}). Bun.YAML.parse
// accepts both, so this reader understands both: indented block maps at the
// document root plus flow maps/arrays and quoted/plain scalars as leaves. The
// launcher reads only the one destination scalar, and a document this reader
// cannot parse reports an error exactly like the TS side's parse-failure lane
// (a rejected document reads as "not connected").

import (
	"errors"
	"strings"
)

// yamlFlowValue is the parsed value tree: map[string]any, []any, string, or nil.
type yamlFlowParser struct {
	text string
	pos  int
}

func mcodeYamlBaseURL(text string) (string, bool) {
	value, err := parseYamlDocument(text)
	if err != nil {
		return "", false
	}
	root, ok := value.(map[string]any)
	if !ok {
		return "", false
	}
	provider, ok := nestedYamlMap(root, "custom_provider")
	if !ok {
		return "", false
	}
	opencodex, ok := nestedYamlMap(provider, "opencodex")
	if !ok {
		return "", false
	}
	options, ok := nestedYamlMap(opencodex, "options")
	if !ok {
		return "", false
	}
	baseURL, ok := options["baseURL"]
	if !ok {
		return "", false
	}
	textValue, ok := baseURL.(string)
	return textValue, ok
}

func nestedYamlMap(parent map[string]any, key string) (map[string]any, bool) {
	child, ok := parent[key]
	if !ok {
		return nil, false
	}
	mapped, ok := child.(map[string]any)
	return mapped, ok
}

// parseYamlDocument parses the subset described above: a flow document when the
// first non-space byte is { or [, an indented block map otherwise.
func parseYamlDocument(text string) (any, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, errors.New("yaml: empty document")
	}
	switch trimmed[0] {
	case '{', '[':
		return parseYamlFlow(text)
	}
	return parseYamlBlock(text)
}

// Block-map parsing (the canonical serialize.ts shape). Unsupported sibling
// constructs (block sequences, block scalars, exotic values) are consumed
// opaquely so a config with richer keys still yields the destination scalar
// under custom_provider.opencodex.options.

type yamlBlockLine struct {
	indent int
	text   string
}

func collectYamlBlockLines(text string) []yamlBlockLine {
	lines := []yamlBlockLine{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, " \t\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") || trimmed == "---" || trimmed == "..." {
			continue
		}
		indent := 0
		for indent < len(line) && (line[indent] == ' ' || line[indent] == '\t') {
			indent++
		}
		lines = append(lines, yamlBlockLine{indent: indent, text: line[indent:]})
	}
	return lines
}

func parseYamlBlock(text string) (map[string]any, error) {
	lines := collectYamlBlockLines(text)
	if len(lines) == 0 {
		return nil, errors.New("yaml: empty document")
	}
	if lines[0].indent != 0 {
		return nil, errors.New("yaml: document root must not be indented")
	}
	result, at, err := parseYamlBlockMapAt(lines, 0)
	if err != nil {
		return nil, err
	}
	if at != len(lines) {
		return nil, errors.New("yaml: trailing content after document")
	}
	return result, nil
}

func parseYamlBlockMapAt(lines []yamlBlockLine, at int) (map[string]any, int, error) {
	if at >= len(lines) {
		return nil, at, errors.New("yaml: expected block map")
	}
	indent := lines[at].indent
	result := map[string]any{}
	for at < len(lines) {
		line := lines[at]
		if line.indent < indent {
			break
		}
		if line.indent > indent {
			return nil, at, errors.New("yaml: unexpected indentation")
		}
		key, remainder, isMapEntry := splitYamlBlockKey(line.text)
		if !isMapEntry {
			return nil, at, errors.New("yaml: expected key at block start")
		}
		rest := strings.TrimSpace(remainder)
		if rest == "" {
			if at+1 < len(lines) && lines[at+1].indent > indent {
				child, next, err := parseYamlBlockMapAt(lines, at+1)
				if err == nil {
					result[key] = child
					at = next
					continue
				}
				// A deeper block this reader does not model (a sequence, a block
				// scalar): consume it opaquely rather than failing the document.
				at = consumeYamlBlock(lines, at+1, indent)
				result[key] = nil
				continue
			}
			result[key] = nil
			at++
			continue
		}
		if rest[0] == '|' || rest[0] == '>' {
			// Block scalar indicator: the content lines belong to this value.
			at = consumeYamlBlock(lines, at+1, indent)
			result[key] = nil
			continue
		}
		if cut, ok := cutYamlTrailingComment(rest); ok {
			rest = cut
		}
		value, err := parseYamlInlineValue(rest)
		if err != nil {
			// An unreadable inline value keeps the key as null instead of
			// failing the whole document; only the destination scalar matters.
			result[key] = nil
			at++
			continue
		}
		result[key] = value
		at++
	}
	return result, at, nil
}

func consumeYamlBlock(lines []yamlBlockLine, at int, parentIndent int) int {
	for at < len(lines) && lines[at].indent > parentIndent {
		at++
	}
	return at
}

// splitYamlBlockKey splits `key: value` at the first colon that ends a key
// (outside quotes, followed by whitespace or end of line).
func splitYamlBlockKey(text string) (string, string, bool) {
	inDouble := false
	inSingle := false
	for index := 0; index < len(text); index++ {
		switch text[index] {
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case ':':
			if inDouble || inSingle {
				continue
			}
			if index+1 >= len(text) || isYamlSpaceByte(text[index+1]) {
				key := strings.TrimSpace(text[:index])
				if len(key) >= 2 && key[0] == '"' && key[len(key)-1] == '"' {
					key = key[1 : len(key)-1]
				} else if len(key) >= 2 && key[0] == '\'' && key[len(key)-1] == '\'' {
					key = key[1 : len(key)-1]
				}
				return key, text[index+1:], true
			}
		}
	}
	return "", "", false
}

// cutYamlTrailingComment strips a ` # comment` outside quotes when the hash is
// preceded by whitespace (a bare # inside a URL or key is kept).
func cutYamlTrailingComment(text string) (string, bool) {
	inDouble := false
	inSingle := false
	for index := 0; index < len(text); index++ {
		switch text[index] {
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '#':
			if !inDouble && !inSingle && index > 0 && isYamlSpaceByte(text[index-1]) {
				return strings.TrimSpace(text[:index]), true
			}
		}
	}
	return text, false
}

// parseYamlInlineValue parses the remainder of a `key: value` line: flow maps
// and arrays reuse the flow parser, quoted scalars reuse its quoted lanes, and
// plain scalars run to the end of the line.
func parseYamlInlineValue(rest string) (any, error) {
	if rest == "" {
		return nil, nil
	}
	parser := &yamlFlowParser{text: rest, pos: 0}
	parser.skipSpaceAndComments()
	if parser.pos >= len(parser.text) {
		return nil, nil
	}
	if parser.text[parser.pos] == '{' || parser.text[parser.pos] == '[' {
		return parser.parseValue()
	}
	if parser.text[parser.pos] == '"' {
		return parser.parseDoubleQuoted()
	}
	if parser.text[parser.pos] == '\'' {
		return parser.parseSingleQuoted()
	}
	value := strings.TrimSpace(parser.text)
	if value == "null" || value == "~" {
		return nil, nil
	}
	return value, nil
}

func parseYamlFlow(text string) (any, error) {
	parser := &yamlFlowParser{text: text, pos: 0}
	parser.skipSpaceAndComments()
	value, err := parser.parseValue()
	if err != nil {
		return nil, err
	}
	return value, nil
}

func (p *yamlFlowParser) skipSpaceAndComments() {
	for p.pos < len(p.text) {
		char := p.text[p.pos]
		if char == ' ' || char == '\t' || char == '\r' || char == '\n' {
			p.pos++
			continue
		}
		if char == '#' && (p.pos == 0 || isYamlSpaceByte(p.text[p.pos-1])) {
			for p.pos < len(p.text) && p.text[p.pos] != '\n' {
				p.pos++
			}
			continue
		}
		return
	}
}

func isYamlSpaceByte(char byte) bool {
	return char == ' ' || char == '\t'
}

func (p *yamlFlowParser) parseValue() (any, error) {
	if p.pos >= len(p.text) {
		return nil, errYamlUnparsed
	}
	switch p.text[p.pos] {
	case '{':
		return p.parseMap()
	case '[':
		return p.parseArray()
	case '"':
		return p.parseDoubleQuoted()
	case '\'':
		return p.parseSingleQuoted()
	default:
		return p.parsePlain()
	}
}

func (p *yamlFlowParser) parseMap() (map[string]any, error) {
	p.pos++ // consume '{'
	result := map[string]any{}
	p.skipSpaceAndComments()
	if p.pos < len(p.text) && p.text[p.pos] == '}' {
		p.pos++
		return result, nil
	}
	for {
		p.skipSpaceAndComments()
		if p.pos >= len(p.text) {
			return nil, errYamlUnparsed
		}
		var key string
		if p.text[p.pos] == '"' {
			quoted, err := p.parseDoubleQuoted()
			if err != nil {
				return nil, err
			}
			key = quoted
		} else if p.text[p.pos] == '\'' {
			quoted, err := p.parseSingleQuoted()
			if err != nil {
				return nil, err
			}
			key = quoted
		} else {
			key = p.parseKey()
			if key == "" {
				return nil, errYamlUnparsed
			}
		}
		p.skipSpaceAndComments()
		if p.pos >= len(p.text) || p.text[p.pos] != ':' {
			return nil, errYamlUnparsed
		}
		p.pos++
		p.skipSpaceAndComments()
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		result[key] = value
		p.skipSpaceAndComments()
		if p.pos >= len(p.text) {
			return nil, errYamlUnparsed
		}
		if p.text[p.pos] == ',' {
			p.pos++
			p.skipSpaceAndComments()
			if p.pos < len(p.text) && p.text[p.pos] == '}' {
				p.pos++
				return result, nil
			}
			continue
		}
		if p.text[p.pos] == '}' {
			p.pos++
			return result, nil
		}
		return nil, errYamlUnparsed
	}
}

func (p *yamlFlowParser) parseArray() ([]any, error) {
	p.pos++ // consume '['
	result := []any{}
	p.skipSpaceAndComments()
	if p.pos < len(p.text) && p.text[p.pos] == ']' {
		p.pos++
		return result, nil
	}
	for {
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		result = append(result, value)
		p.skipSpaceAndComments()
		if p.pos >= len(p.text) {
			return nil, errYamlUnparsed
		}
		if p.text[p.pos] == ',' {
			p.pos++
			continue
		}
		if p.text[p.pos] == ']' {
			p.pos++
			return result, nil
		}
		return nil, errYamlUnparsed
	}
}

func (p *yamlFlowParser) parseDoubleQuoted() (string, error) {
	p.pos++ // consume opening quote
	var out strings.Builder
	for p.pos < len(p.text) {
		char := p.text[p.pos]
		if char == '"' {
			p.pos++
			return out.String(), nil
		}
		if char == '\\' {
			p.pos++
			if p.pos >= len(p.text) {
				return "", errYamlUnparsed
			}
			escaped := p.text[p.pos]
			switch escaped {
			case 'n':
				out.WriteByte('\n')
			case 't':
				out.WriteByte('\t')
			case 'r':
				out.WriteByte('\r')
			case '"':
				out.WriteByte('"')
			case '\\':
				out.WriteByte('\\')
			default:
				out.WriteByte(escaped)
			}
			p.pos++
			continue
		}
		out.WriteByte(char)
		p.pos++
	}
	return "", errYamlUnparsed
}

func (p *yamlFlowParser) parseSingleQuoted() (string, error) {
	p.pos++ // consume opening quote
	var out strings.Builder
	for p.pos < len(p.text) {
		char := p.text[p.pos]
		if char == '\'' {
			if p.pos+1 < len(p.text) && p.text[p.pos+1] == '\'' {
				out.WriteByte('\'')
				p.pos += 2
				continue
			}
			p.pos++
			return out.String(), nil
		}
		out.WriteByte(char)
		p.pos++
	}
	return "", errYamlUnparsed
}

// parseKey reads an unquoted flow-map key, which ends at the separating ':'. A
// key may not contain flow indicators or whitespace-broken colons in the docs
// opencodex generates; anything exotic makes the document unreadable.
func (p *yamlFlowParser) parseKey() string {
	start := p.pos
	for p.pos < len(p.text) {
		char := p.text[p.pos]
		if char == ':' {
			break
		}
		if char == ',' || char == '}' || char == '{' || char == ']' || char == '[' || char == '\n' || char == '\r' {
			return ""
		}
		p.pos++
	}
	if p.pos >= len(p.text) {
		return ""
	}
	value := strings.TrimSpace(p.text[start:p.pos])
	if value == "" {
		return ""
	}
	return value
}

func (p *yamlFlowParser) parsePlain() (string, error) {
	start := p.pos
	for p.pos < len(p.text) {
		char := p.text[p.pos]
		if char == ',' || char == '}' || char == ']' || char == '{' || char == '[' {
			break
		}
		if char == '#' && p.pos > start && isYamlSpaceByte(p.text[p.pos-1]) {
			break
		}
		if char == '\n' || char == '\r' {
			break
		}
		p.pos++
	}
	if p.pos == start {
		return "", errYamlUnparsed
	}
	value := strings.TrimSpace(p.text[start:p.pos])
	if value == "null" || value == "~" {
		return "", nil
	}
	return value, nil
}

var errYamlUnparsed = &yamlUnparsedError{}

type yamlUnparsedError struct{}

func (*yamlUnparsedError) Error() string { return "yaml: cannot parse flow document" }
