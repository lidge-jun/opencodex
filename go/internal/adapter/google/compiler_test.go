package google

import (
	"encoding/json"
	"regexp"
	"testing"
)

func TestCompileGoogleWireBodyConservativelyRewritesNamesAndConfig(t *testing.T) {
	original := "9 bad.tool name " + string(make([]byte, 80))
	compiled := CompileGoogleWireBody(map[string]any{
		"contents": []any{
			map[string]any{"role": "model", "parts": []any{map[string]any{"functionCall": map[string]any{"name": original, "args": map[string]any{}}}}},
			map[string]any{"role": "user", "parts": []any{map[string]any{"functionResponse": map[string]any{"name": original}}}},
		},
		"tools": []any{map[string]any{"functionDeclarations": []any{map[string]any{
			"name": original, "description": "hostile", "parameters": map[string]any{"type": "object", "future": true}, "future": true,
		}}}},
		"generationConfig": map[string]any{"maxOutputTokens": -2, "temperature": 99.0, "topP": -1, "thinkingConfig": map[string]any{"thinkingLevel": "max"}},
		"future":           true,
	})
	tools := compiled.Body["tools"].([]any)
	declarations := tools[0].(map[string]any)["functionDeclarations"].([]any)
	declaration := declarations[0].(map[string]any)
	wireName := declaration["name"].(string)
	if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`).MatchString(wireName) {
		t.Fatalf("invalid wire name %q", wireName)
	}
	if compiled.RestoreToolName(wireName) != original {
		t.Fatal("tool name did not round trip")
	}
	if _, exists := declaration["future"]; exists {
		t.Fatal("future declaration field reached wire")
	}
	config := compiled.Body["generationConfig"].(map[string]any)
	if config["temperature"] != 2.0 {
		t.Fatalf("temperature = %#v", config["temperature"])
	}
	if config["thinkingConfig"].(map[string]any)["thinkingLevel"] != "high" {
		t.Fatalf("thinking config = %#v", config["thinkingConfig"])
	}
	if _, exists := compiled.Body["future"]; exists {
		t.Fatal("future top-level field reached wire")
	}
}

func TestRepairGoogleInvalidRequestBodyTargetsRejectedSchema(t *testing.T) {
	body := `{"request":{"generationConfig":{"maxOutputTokens":4096,"thinkingConfig":{"thinkingLevel":"high"}},"tools":[{"functionDeclarations":[{"name":"safe","parameters":{"type":"object","properties":{"x":{"type":"string"}}}},{"name":"bad","parameters":{"type":"array"}}]}]}}`
	repaired, ok := RepairGoogleInvalidRequestBody(body, `tools.1.custom.input_schema and thinking_config are invalid`)
	if !ok {
		t.Fatal("expected compatibility repair")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(repaired), &parsed); err != nil {
		t.Fatal(err)
	}
	request := parsed["request"].(map[string]any)
	config := request["generationConfig"].(map[string]any)
	if _, exists := config["thinkingConfig"]; exists || config["maxOutputTokens"] != float64(4096) {
		t.Fatalf("generation config = %#v", config)
	}
	declarations := request["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)
	safe := declarations[0].(map[string]any)["parameters"].(map[string]any)
	if _, exists := safe["properties"]; !exists {
		t.Fatal("safe schema was incorrectly replaced")
	}
	bad := declarations[1].(map[string]any)["parameters"].(map[string]any)
	if bad["type"] != "object" {
		t.Fatalf("bad schema = %#v", bad)
	}
}
