package google

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"slices"
	"strings"
)

var googleToolNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)

type CompiledBody struct {
	Body            map[string]any
	RestoreToolName func(string) string
}

// CompileGoogleWireBody is the final allowlist boundary for Google-family payloads.
func CompileGoogleWireBody(input any) CompiledBody {
	source, _ := input.(map[string]any)
	codec := newToolNameCodec(collectToolNames(source))
	body := map[string]any{}
	if contents := compileContents(source["contents"], codec.toWire); contents != nil {
		body["contents"] = contents
	}
	if instruction, ok := source["systemInstruction"].(map[string]any); ok {
		body["systemInstruction"] = instruction
	}
	if tools := compileTools(source["tools"], codec.toWire); tools != nil {
		body["tools"] = tools
	}
	if config := compileGenerationConfig(source["generationConfig"]); config != nil {
		body["generationConfig"] = config
	}
	if config := compileToolConfig(source["toolConfig"], codec.toWire); config != nil {
		body["toolConfig"] = config
	}
	if session, ok := source["sessionId"].(string); ok && session != "" {
		body["sessionId"] = session
	}
	return CompiledBody{Body: body, RestoreToolName: codec.fromWire}
}

type toolNameCodec struct {
	forward map[string]string
	reverse map[string]string
}

func newToolNameCodec(names []string) toolNameCodec {
	codec := toolNameCodec{forward: map[string]string{}, reverse: map[string]string{}}
	used := map[string]struct{}{}
	for _, name := range names {
		if _, exists := codec.forward[name]; exists {
			continue
		}
		if googleToolNamePattern.MatchString(name) {
			if _, exists := used[name]; !exists {
				codec.forward[name], codec.reverse[name] = name, name
				used[name] = struct{}{}
				continue
			}
		}
		cleaned := regexp.MustCompile(`[^A-Za-z0-9_-]`).ReplaceAllString(name, "_")
		if cleaned == "" {
			cleaned = "tool"
		}
		if !regexp.MustCompile(`^[A-Za-z_]`).MatchString(cleaned) {
			cleaned = "_" + cleaned
		}
		if len(cleaned) > 55 {
			cleaned = cleaned[:55]
		}
		for salt := 0; ; salt++ {
			hashInput := name
			if salt > 0 {
				hashInput += "#" + itoa(salt)
			}
			digest := sha256.Sum256([]byte(hashInput))
			candidate := cleaned + "_" + hex.EncodeToString(digest[:4])
			if _, exists := used[candidate]; exists {
				continue
			}
			codec.forward[name], codec.reverse[candidate] = candidate, name
			used[candidate] = struct{}{}
			break
		}
	}
	return codec
}

func (c toolNameCodec) toWire(name string) string {
	if value, ok := c.forward[name]; ok {
		return value
	}
	return name
}

func (c toolNameCodec) fromWire(name string) string {
	if value, ok := c.reverse[name]; ok {
		return value
	}
	return name
}

func collectToolNames(body map[string]any) []string {
	if body == nil {
		return nil
	}
	names := make([]string, 0)
	for _, rawTool := range anySlice(body["tools"]) {
		tool, _ := rawTool.(map[string]any)
		for _, rawDeclaration := range anySlice(tool["functionDeclarations"]) {
			declaration, _ := rawDeclaration.(map[string]any)
			if name, ok := declaration["name"].(string); ok {
				names = append(names, name)
			}
		}
	}
	for _, rawContent := range anySlice(body["contents"]) {
		content, _ := rawContent.(map[string]any)
		for _, rawPart := range anySlice(content["parts"]) {
			part, _ := rawPart.(map[string]any)
			for _, key := range []string{"functionCall", "functionResponse"} {
				call, _ := part[key].(map[string]any)
				if name, ok := call["name"].(string); ok {
					names = append(names, name)
				}
			}
		}
	}
	return names
}

func compileContents(value any, toWire func(string) string) []any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(items))
	for _, rawContent := range items {
		content, ok := rawContent.(map[string]any)
		if !ok {
			out = append(out, map[string]any{})
			continue
		}
		copyContent := cloneObject(content)
		parts, ok := content["parts"].([]any)
		if !ok {
			out = append(out, copyContent)
			continue
		}
		compiledParts := make([]any, 0, len(parts))
		for _, rawPart := range parts {
			part, ok := rawPart.(map[string]any)
			if !ok {
				compiledParts = append(compiledParts, map[string]any{})
				continue
			}
			copyPart := cloneObject(part)
			for _, key := range []string{"functionCall", "functionResponse"} {
				call, ok := part[key].(map[string]any)
				if !ok {
					continue
				}
				copyCall := cloneObject(call)
				if name, ok := call["name"].(string); ok {
					copyCall["name"] = toWire(name)
				}
				copyPart[key] = copyCall
			}
			compiledParts = append(compiledParts, copyPart)
		}
		copyContent["parts"] = compiledParts
		out = append(out, copyContent)
	}
	return out
}

func compileTools(value any, toWire func(string) string) []any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(items))
	for _, rawTool := range items {
		tool, ok := rawTool.(map[string]any)
		if !ok {
			continue
		}
		declarations := make([]any, 0)
		for _, rawDeclaration := range anySlice(tool["functionDeclarations"]) {
			declaration, ok := rawDeclaration.(map[string]any)
			if !ok {
				continue
			}
			name, ok := declaration["name"].(string)
			if !ok {
				continue
			}
			compiled := map[string]any{"name": toWire(name), "parameters": SanitizeGeminiToolParameters(declaration["parameters"])}
			if description, ok := declaration["description"].(string); ok {
				compiled["description"] = description
			}
			declarations = append(declarations, compiled)
		}
		if len(declarations) > 0 {
			out = append(out, map[string]any{"functionDeclarations": declarations})
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func compileGenerationConfig(value any) map[string]any {
	input, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]any{}
	if number, ok := finiteNumber(input["maxOutputTokens"]); ok && number > 0 {
		out["maxOutputTokens"] = int(math.Floor(number))
	}
	if number, ok := finiteNumber(input["temperature"]); ok && number >= 0 {
		out["temperature"] = min(2, number)
	}
	if number, ok := finiteNumber(input["topP"]); ok && number >= 0 {
		out["topP"] = min(1, number)
	}
	if stops := uniqueNonEmptyStrings(input["stopSequences"], 5); len(stops) > 0 {
		out["stopSequences"] = stops
	}
	if thinking, ok := input["thinkingConfig"].(map[string]any); ok {
		if level, ok := thinking["thinkingLevel"].(string); ok {
			level = strings.ToLower(level)
			if slices.Contains([]string{"xhigh", "max", "ultra"}, level) {
				level = "high"
			}
			if slices.Contains([]string{"minimal", "low", "medium", "high"}, level) {
				out["thinkingConfig"] = map[string]any{"thinkingLevel": level}
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func compileToolConfig(value any, toWire func(string) string) map[string]any {
	input, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := input["functionCallingConfig"].(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]any{}
	if mode, ok := raw["mode"].(string); ok {
		mode = strings.ToUpper(mode)
		if slices.Contains([]string{"AUTO", "ANY", "NONE", "VALIDATED"}, mode) {
			out["mode"] = mode
		}
	}
	if names := uniqueNonEmptyStrings(raw["allowedFunctionNames"], 0); len(names) > 0 {
		for index := range names {
			names[index] = toWire(names[index])
		}
		out["allowedFunctionNames"] = names
	}
	if len(out) == 0 {
		return nil
	}
	return map[string]any{"functionCallingConfig": out}
}

// RepairGoogleInvalidRequestBody creates one known-safe compatibility replay body.
func RepairGoogleInvalidRequestBody(body, errorPayload string) (string, bool) {
	schemaError := regexp.MustCompile(`(?i)(input[_ ]schema|json schema|function[_ ]declarations?|x-mcp-header)`).MatchString(errorPayload)
	thinkingError := regexp.MustCompile(`(?i)thinking[_ ]?(config|level)`).MatchString(errorPayload)
	if !schemaError && !thinkingError {
		return "", false
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(body), &parsed) != nil {
		return "", false
	}
	root := parsed
	if request, ok := parsed["request"].(map[string]any); ok {
		root = request
	}
	changed := false
	if thinkingError {
		if config, ok := root["generationConfig"].(map[string]any); ok {
			if _, exists := config["thinkingConfig"]; exists {
				delete(config, "thinkingConfig")
				if len(config) == 0 {
					delete(root, "generationConfig")
				}
				changed = true
			}
		}
	}
	if schemaError {
		declarations := functionDeclarations(root)
		if len(declarations) > 0 {
			index := rejectedDeclarationIndex(errorPayload)
			targets := declarations
			if index >= 0 && index < len(declarations) {
				targets = declarations[index : index+1]
			}
			for _, declaration := range targets {
				declaration["parameters"] = map[string]any{"type": "object", "properties": map[string]any{}}
				delete(declaration, "parametersJsonSchema")
			}
			changed = true
		}
	}
	if !changed {
		return "", false
	}
	encoded, err := json.Marshal(parsed)
	return string(encoded), err == nil
}

func functionDeclarations(root map[string]any) []map[string]any {
	out := make([]map[string]any, 0)
	for _, rawTool := range anySlice(root["tools"]) {
		tool, _ := rawTool.(map[string]any)
		for _, rawDeclaration := range anySlice(tool["functionDeclarations"]) {
			if declaration, ok := rawDeclaration.(map[string]any); ok {
				out = append(out, declaration)
			}
		}
	}
	return out
}

func rejectedDeclarationIndex(payload string) int {
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)tools(?:\.|\[)(\d+)(?:\])?\.custom\.input_schema`),
		regexp.MustCompile(`(?i)function_?declarations(?:\.|\[)(\d+)`),
	}
	for _, pattern := range patterns {
		match := pattern.FindStringSubmatch(payload)
		if len(match) == 2 {
			return atoi(match[1])
		}
	}
	return -1
}

func finiteNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	case float32:
		value := float64(number)
		return value, !math.IsNaN(value) && !math.IsInf(value, 0)
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	default:
		return 0, false
	}
}

func anySlice(value any) []any {
	items, _ := value.([]any)
	return items
}

func uniqueNonEmptyStrings(value any, limit int) []string {
	items := make([]string, 0)
	switch values := value.(type) {
	case []any:
		for _, item := range values {
			if text, ok := item.(string); ok && text != "" {
				items = append(items, text)
			}
		}
	case []string:
		for _, text := range values {
			if text != "" {
				items = append(items, text)
			}
		}
	}
	items = dedupeStrings(items)
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items
}

func atoi(value string) int {
	result := 0
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return -1
		}
		result = result*10 + int(digit-'0')
	}
	return result
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	buf := make([]byte, 0, 10)
	for value > 0 {
		buf = append(buf, byte('0'+value%10))
		value /= 10
	}
	for left, right := 0, len(buf)-1; left < right; left, right = left+1, right-1 {
		buf[left], buf[right] = buf[right], buf[left]
	}
	return string(buf)
}
