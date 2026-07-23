package google

import (
	"reflect"
	"testing"
)

func TestSanitizeGeminiToolParametersRewritesRecursiveSchema(t *testing.T) {
	input := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"message": map[string]any{"type": "string", "encrypted": true, "x-mcp-header": "Authorization"},
			"status": map[string]any{"description": "state", "anyOf": []any{
				map[string]any{"type": "string", "enum": []any{"open", "closed"}},
				map[string]any{"type": "string", "enum": []any{"deleted"}},
			}},
			"optional": map[string]any{"anyOf": []any{
				map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				map[string]any{"type": "null"},
			}},
		},
		"required": []any{"message", "message", 42},
		"$schema":  "https://json-schema.org/draft/2020-12/schema",
	}
	out := SanitizeGeminiToolParameters(input)
	properties := out["properties"].(map[string]any)
	message := properties["message"].(map[string]any)
	if _, exists := message["encrypted"]; exists {
		t.Fatal("encrypted marker reached Gemini schema")
	}
	if _, exists := message["x-mcp-header"]; exists {
		t.Fatal("MCP header annotation reached Gemini schema")
	}
	status := properties["status"].(map[string]any)
	if got := status["enum"]; !reflect.DeepEqual(got, []string{"open", "closed", "deleted"}) {
		t.Fatalf("collapsed enum = %#v", got)
	}
	optional := properties["optional"].(map[string]any)
	if optional["type"] != "array" || optional["nullable"] != true {
		t.Fatalf("nullable anyOf = %#v", optional)
	}
	if got := out["required"]; !reflect.DeepEqual(got, []string{"message"}) {
		t.Fatalf("required = %#v", got)
	}
	if _, exists := out["$schema"]; exists {
		t.Fatal("unsupported root keyword reached Gemini schema")
	}
	if input["$schema"] == nil {
		t.Fatal("input was mutated")
	}
}

func TestSanitizeGeminiToolParametersDereferencesLocalDefsAndWidensUnion(t *testing.T) {
	out := SanitizeGeminiToolParameters(map[string]any{
		"$defs": map[string]any{"Name": map[string]any{"type": "string", "description": "name"}},
		"properties": map[string]any{
			"name":  map[string]any{"$ref": "#/$defs/Name"},
			"value": map[string]any{"description": "mixed", "anyOf": []any{map[string]any{"type": "string"}, map[string]any{"type": "number"}}},
		},
	})
	properties := out["properties"].(map[string]any)
	if !reflect.DeepEqual(properties["name"], map[string]any{"type": "string", "description": "name"}) {
		t.Fatalf("dereferenced schema = %#v", properties["name"])
	}
	if !reflect.DeepEqual(properties["value"], map[string]any{"description": "mixed"}) {
		t.Fatalf("widened union = %#v", properties["value"])
	}
}
