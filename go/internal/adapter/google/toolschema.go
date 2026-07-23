package google

import (
	"net/url"
	"strings"
)

const (
	maxSchemaDepth = 24
	maxDerefDepth  = 16
)

var allowedSchemaTypes = map[string]struct{}{
	"string": {}, "integer": {}, "number": {}, "boolean": {}, "array": {}, "object": {},
}

// SanitizeGeminiToolParameters rewrites arbitrary JSON Schema into the conservative
// subset accepted by Gemini function declarations. The input is never mutated.
func SanitizeGeminiToolParameters(parameters any) map[string]any {
	defs := make(map[string]any)
	collectDefs(parameters, defs)
	root := sanitizeSchema(parameters, defs, 0, 0, false)
	root["type"] = "object"
	if _, ok := root["properties"].(map[string]any); !ok {
		root["properties"] = map[string]any{}
	}
	return root
}

func collectDefs(root any, defs map[string]any) {
	object, ok := root.(map[string]any)
	if !ok {
		return
	}
	for _, key := range []string{"$defs", "definitions"} {
		group, ok := object[key].(map[string]any)
		if !ok {
			continue
		}
		for name, value := range group {
			if _, exists := defs[name]; !exists {
				defs[name] = value
			}
		}
	}
}

func sanitizeSchema(node any, defs map[string]any, depth, refDepth int, preserveNull bool) map[string]any {
	if depth >= maxSchemaDepth {
		return map[string]any{}
	}
	object, ok := node.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	if ref, ok := object["$ref"].(string); ok && refDepth < maxDerefDepth {
		if target, ok := resolveLocalRef(ref, defs).(map[string]any); ok {
			merged := cloneObject(target)
			for key, value := range object {
				if key != "$ref" {
					merged[key] = value
				}
			}
			return sanitizeSchema(merged, defs, depth, refDepth+1, preserveNull)
		}
	}

	out := map[string]any{}
	normalizeSchemaType(object["type"], out, preserveNull)
	if value, ok := object["nullable"].(bool); ok {
		out["nullable"] = value
	}
	for _, key := range []string{"description", "format"} {
		if value, ok := object[key].(string); ok {
			out[key] = value
		}
	}
	enumSource := object["enum"]
	if value, ok := object["const"].(string); ok && enumSource == nil {
		enumSource = []any{value}
	}
	if values := uniqueStrings(enumSource); len(values) > 0 {
		out["enum"] = values
	}
	if properties, ok := object["properties"].(map[string]any); ok {
		sanitized := make(map[string]any, len(properties))
		for name, schema := range properties {
			sanitized[name] = sanitizeSchema(schema, defs, depth+1, refDepth, false)
		}
		out["properties"] = sanitized
	}
	if items, ok := object["items"].(map[string]any); ok {
		out["items"] = sanitizeSchema(items, defs, depth+1, refDepth, false)
	}
	if required := uniqueStrings(object["required"]); required != nil {
		out["required"] = required
	}
	if anyOf, exists := object["anyOf"]; exists {
		for key, value := range normalizeAnyOf(anyOf, defs, depth, refDepth) {
			out[key] = value
		}
	}
	return out
}

func resolveLocalRef(ref string, defs map[string]any) any {
	var encoded string
	switch {
	case strings.HasPrefix(ref, "#/$defs/"):
		encoded = strings.TrimPrefix(ref, "#/$defs/")
	case strings.HasPrefix(ref, "#/definitions/"):
		encoded = strings.TrimPrefix(ref, "#/definitions/")
	default:
		return nil
	}
	decoded, err := url.PathUnescape(strings.ReplaceAll(strings.ReplaceAll(encoded, "~1", "/"), "~0", "~"))
	if err != nil {
		return nil
	}
	return defs[decoded]
}

func normalizeSchemaType(value any, out map[string]any, preserveNull bool) {
	values := []any{value}
	if list, ok := value.([]any); ok {
		values = list
	}
	sawNull := false
	for _, candidate := range values {
		raw, ok := candidate.(string)
		if !ok {
			continue
		}
		kind := strings.ToLower(raw)
		if kind == "null" {
			sawNull = true
			continue
		}
		if _, exists := out["type"]; !exists {
			if _, allowed := allowedSchemaTypes[kind]; allowed {
				out["type"] = kind
			}
		}
	}
	if sawNull {
		if _, exists := out["type"]; exists {
			out["nullable"] = true
		} else if preserveNull {
			out["type"] = "null"
		} else {
			out["nullable"] = true
		}
	}
}

func normalizeAnyOf(value any, defs map[string]any, depth, refDepth int) map[string]any {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return map[string]any{}
	}
	schemas := make([]map[string]any, 0, len(items))
	for _, item := range items {
		schemas = append(schemas, sanitizeSchema(item, defs, depth+1, refDepth, true))
	}
	nonNull := make([]map[string]any, 0, len(schemas))
	nullOnly := 0
	for _, schema := range schemas {
		if schema["type"] == "null" {
			if len(schema) == 1 {
				nullOnly++
			}
			continue
		}
		nonNull = append(nonNull, schema)
	}
	if len(nonNull) == 1 && nullOnly == len(schemas)-1 && nullOnly > 0 {
		out := cloneObject(nonNull[0])
		out["nullable"] = true
		return out
	}

	firstType := schemas[0]["type"]
	values := make([]string, 0)
	for _, schema := range schemas {
		if schema["type"] != firstType || firstType == "null" {
			return map[string]any{}
		}
		for key := range schema {
			if key != "type" && key != "enum" {
				return map[string]any{}
			}
		}
		enums := uniqueStrings(schema["enum"])
		if len(enums) == 0 {
			return map[string]any{}
		}
		values = append(values, enums...)
	}
	values = dedupeStrings(values)
	out := map[string]any{"enum": values}
	if kind, ok := firstType.(string); ok {
		out["type"] = kind
	}
	return out
}

func uniqueStrings(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if stringsList, ok := value.([]string); ok {
			return dedupeStrings(stringsList)
		}
		return nil
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		if value, ok := item.(string); ok {
			values = append(values, value)
		}
	}
	return dedupeStrings(values)
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func cloneObject(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
