package ocxcli

// YAML-subset reader for the MiniMax Code launcher's config destination check.
//
// opencodex writes the managed MCode provider document with Bun.YAML.stringify,
// which emits single-line FLOW YAML ({custom_provider: {opencodex: {options:
// {baseURL: http://…}}}}). The launcher reads only the one destination scalar,
// so this parser understands that generated shape — nested {} maps, [] arrays,
// quoted and plain scalars — and reports an error for anything it cannot read,
// which mirrors the TS side's `Bun.YAML.parse` failure lane (a document the
// parser rejects reads as "not connected", exactly like a Bun reject).

import "strings"

// yamlFlowValue is the parsed value tree: map[string]any, []any, string, or nil.
type yamlFlowParser struct {
	text string
	pos  int
}

func mcodeYamlBaseURL(text string) (string, bool) {
	value, err := parseYamlFlow(text)
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
